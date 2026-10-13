// src/views/printTemplates/composables/usePrintTemplatesStore.ts
//
// 2026-10-16 新建：送货单打印模板管理页的页面级 Pinia setup store。形态照
// `views/mail/accounts/composables/useMailAccountsStore.ts`（切片形态 + `$dispose` 契约 +
// query hook 外提 + Zod 守门 + mutation 统一失效 + 统一错误入口）。
//
// 不变量（改动前必读，抄自 useMailAccountsStore）：
// 1. 必须在 PrintTemplateList.vue 的 setup 内首调。组件外（路由守卫 / 其它 store）禁止。
// 2. PrintTemplateList.vue 的 onBeforeUnmount 必须 `store.$dispose()`：Pinia 是单例，
//    不 dispose 会把「选中的客户 / 上传中的半截状态」泄漏到下次进入。
// 3. 消费侧禁止解构 store（reactive 解构丢响应式）；统一 `store.切片.字段` 访问，不写
//    .value（深代理自动解包）。store 内部闭包持 raw 态，照写 .value。
// 4. 不 import vue-router（本页没有导航需求）。
//
// ⚠️ **上传前的模板校验在本 store 里、且校验不过就不发请求**：坏模板（列位错位 / 缺占位符）
// 若先落库，打印对话框打开时会被自动选用 → 导出的送货单在客户签字那页就是废纸。把闸门前移到
// 入库之前，代价只是用户当场看到差异，收益是库里永远只有「能打印」的模板。
//
// ⚠️ **失败也失效**：上传失败与软删失败都刷新本域列表 —— 失败那一刻说明本端副本**已经不等于
// 真源**（21109 / 21102 / 40901 都是「你看到的不是当前真相」的信号），理由同
// `useMailAccountsStore::handleWriteError`。

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import {
  deletePrintTemplate,
  fetchPrintTemplateContent,
  isPrintTemplateXlsxName,
  uploadPrintTemplate,
  type ListPrintTemplatesParams,
} from '@/api/printTemplates';
import { qk } from '@/composables/queries/keys';
import { triggerBrowserDownload } from '@/utils/download';
import { assertTemplateMatches } from '@/views/com/delivery/utils/deliveryNoteTemplate';
import { XLSX_MIME } from '@/views/com/delivery/utils/deliveryNoteTemplateContract';
import { PRINT_TEMPLATE_ACCEPT_EXT, type PrintTemplateData } from '../printTemplateSchema';
import { usePrintTemplateListQuery } from './usePrintTemplateListQuery';

/** 列表一次拉多少条。后端 clamp 上限比这大，但模板是配置数据、现实中一个 L1 就一行，
 *  给一个够用又不至于让「切客户」这一下拉回一整页的量。 */
const LIST_PAGE_SIZE = 200;

export const usePrintTemplatesStore = defineStore('print-templates', () => {
  // ⚠️ 必须在 setup 第一行捕获（Pinia 不给 action wrapper / listener 注入上下文，
  // `useQueryClient()` 的守卫会抛）。
  const qc = useQueryClient();

  // enabled 闸门：默认 false，由壳的 onMounted 调 `openGate()` 开闸。
  const ready = ref(false);

  // ============ 切片：filters（一级客户筛选）============
  /** 当前筛选的一级客户 id（`''` = 不筛选，看全部模板）。
   *
   *  ⚠️ 它同时是**上传的目标**：后端的绑定维度就是「模板 ↔ 一个一级客户」，所以「上传按钮
   *  在没选客户时禁用」不是易用性洁癖 —— 没有 customer_id 的 multipart 是后端 40001。 */
  const customerId = ref('');

  const params = computed<ListPrintTemplatesParams>(() => ({
    customer_id: customerId.value || undefined,
    limit: LIST_PAGE_SIZE,
  }));

  const listQuery = usePrintTemplateListQuery({ params, enabled: ready });

  /** 模板列表。**恒为数组**（拿不到时给 `[]`，页面据此渲染空态而不是 `undefined`）。 */
  const rows = computed<PrintTemplateData[]>(() => listQuery.data.value?.items ?? []);
  const loading = listQuery.isFetching;

  function openGate(): void {
    ready.value = true;
  }

  function refresh(): Promise<void> {
    return listQuery.fetchList();
  }

  // ============ 切片：actions（上传 / 下载 / 软删）============
  /** 写完立即失效本域（「写完立即看到自己那笔」的优化，非一致性保证）。 */
  function invalidatePrintTemplatesQuery(): Promise<void> {
    return qc.invalidateQueries({ queryKey: qk.printTemplatesPrefix }).then(() => undefined);
  }

  /**
   * 上传前的逐格校验结果（**空数组 = 通过 / 还没校验过**）。
   *
   * 差异原文逐条摆到页面上（`.upload-diffs`），用户据此看出自己改错了哪一格 —— 与打印对话框
   * 那条提示共用 `assertTemplateMatches` 的输出，措辞自然一致。
   */
  const uploadDiffs = ref<string[]>([]);
  /** 上传 / 校验中的整体 loading（表格与按钮共用一个，避免两个转圈互相盖住）。 */
  const busy = ref(false);

  const uploadMutation = useMutation({
    mutationKey: ['print-templates', 'upload'],
    mutationFn: (vars: { customerId: string; file: File }) =>
      uploadPrintTemplate(vars.customerId, vars.file),
    onSuccess: async () => {
      await invalidatePrintTemplatesQuery();
      ElMessage.success('模板已保存并绑定到该一级客户（同一客户再次上传即替换）');
    },
    onError: async (e: Error & { code?: number }) => {
      await invalidatePrintTemplatesQuery();
      ElMessage.error(e.message ?? '模板上传失败');
    },
  });

  /**
   * 上传一份模板（校验 → 请求两步）。
   *
   * @returns true = 已入库；false = 校验不过 / 请求失败（两者都已给过提示）。
   */
  async function upload(file: File, targetCustomerId: string): Promise<boolean> {
    // 第一道闸：扩展名。本域只允许 xlsx，后端会返 21102；发请求前拦掉省一次往返。
    if (!isPrintTemplateXlsxName(file.name)) {
      uploadDiffs.value = [`只接受 ${PRINT_TEMPLATE_ACCEPT_EXT} 模板（当前文件：${file.name}）`];
      ElMessage.error('模板格式不对，只接受 .xlsx');
      return false;
    }
    busy.value = true;
    uploadDiffs.value = [];
    try {
      // 第二道闸：逐格结构校验。⚠️ 这一步不能省 —— 后端只认「是 xlsx 且是 ZIP」，
      // 一份列位错位的模板在库里是完全合法的，坏在打印那一刻才发现已经晚了。
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { openXlsx } = await import('hucre');
      const diffs = await assertTemplateMatches(await openXlsx(bytes));
      if (diffs.length > 0) {
        uploadDiffs.value = diffs;
        ElMessage.error(`模板校验未通过（${diffs.length} 处差异），已取消上传`);
        return false;
      }
      await uploadMutation.mutateAsync({ customerId: targetCustomerId, file });
      return true;
    } catch (e) {
      // 校验阶段抛错（文件不是能解开的 xlsx / hucre 报错）—— 与「校验不过」同一条路处理。
      uploadDiffs.value = [`模板解析失败：${(e as Error).message}`];
      ElMessage.error('模板解析失败，已取消上传');
      return false;
    } finally {
      busy.value = false;
    }
  }

  /** 正在下载的行 id（`null` = 无）。**按行**挂 loading：布尔量挂到每一行会让整张表的
   *  按钮一起转圈，看不出是哪一条在处理。 */
  const downloadingRowId = ref<string | null>(null);

  /**
   * 下载模板字节。
   *
   * ⚠️ 走 `fetchPrintTemplateContent`（axios、带 Authorization 头）而不是出参里那条
   * `content_url` —— 后者是不含 `/api/v2` 前缀的相对路径、也不带鉴权头，塞进 `<a href>`
   * 必然 401/404。
   */
  async function download(row: PrintTemplateData): Promise<void> {
    downloadingRowId.value = row.id;
    try {
      const bytes = await fetchPrintTemplateContent(row.id);
      // `bytes` 是 hucre / axios 给的 Uint8Array（底层 ArrayBuffer），BlobPart 需要
      // ArrayBuffer 变体 ⇒ 复制进一个新的 ArrayBuffer 再包（体积只有几十 KB）。
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      triggerBrowserDownload(
        new Blob([copy.buffer as ArrayBuffer], { type: XLSX_MIME }),
        row.original_filename,
      );
    } catch (e) {
      ElMessage.error((e as Error).message ?? '模板下载失败');
    } finally {
      downloadingRowId.value = null;
    }
  }

  /** 正在软删的行 id（`null` = 无）。**按行**而不是布尔：布尔量挂到每一行上会让每一行的
   *  按钮一起转圈，看不出是哪一条在处理；而且用户会连点好几次（第二次的 OCC 必然 40901）。 */
  const deletingRowId = ref<string | null>(null);

  const deleteMutation = useMutation({
    mutationKey: ['print-templates', 'delete'],
    // ⚠️ 收**整行**而不是 id：软删端点的 body 必填 `version`（OCC 锚），只把 id 传下去就
    // 必然发一个 `{}` 出去 ⇒ 后端 422 纯文本、连业务码都拿不到。
    mutationFn: (row: PrintTemplateData) => deletePrintTemplate(row.id, { version: row.version }),
    onSuccess: async () => {
      await invalidatePrintTemplatesQuery();
      ElMessage.success('模板已删除');
    },
    onError: async (e: Error & { code?: number }) => {
      await invalidatePrintTemplatesQuery();
      ElMessage.error(e.message ?? '模板删除失败');
    },
  });

  /** 软删。调用方（壳的 `el-popconfirm`）负责二次确认。
   *
   *  ⚠️ 删除后**该一级客户就没有模板了**：打印对话框会自动回落到「请手动选择」，这是产品
   *  拍板的形态（手动上传兜底不撤），提示文案见打印对话框的 `exportHint`。 */
  async function remove(row: PrintTemplateData): Promise<void> {
    deletingRowId.value = row.id;
    try {
      await deleteMutation.mutateAsync(row);
    } catch {
      /* 错误已由 onError 提示 */
    } finally {
      deletingRowId.value = null;
    }
  }

  return {
    query: {
      rows,
      loading,
      /** 当前筛选的一级客户 id（`''` = 全部）。 */
      customerId,
      /** 开 enabled 闸门（壳的 onMounted 调）。放在 query 切片里而不是 shell：
       *  它是「让这条 query 开跑」的动作，与它同属一组。 */
      openGate,
      refresh,
    },
    upload: {
      /** 上传前的逐格校验差异（空数组 = 无差异 / 未校验）。 */
      diffs: uploadDiffs,
      /** 校验 + 上传的进行中。 */
      busy,
      run: upload,
    },
    actions: {
      downloadingRowId,
      /** 正在软删的行 id（`null` = 无）。 */
      deletingRowId,
      download,
      remove,
    },
  };
});
