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
// ⚠️ **ZIP magic 切片校验（2026-10-15 新增，校验职责从后端移交到前端）**：直传链路的
// 后端 confirm 端点只拿到**文件元数据**（大小 / mime / 扩展名），拿不到字节 ⇒ 后端
// 「前 4 字节必须是 `PK\x03\x04`」这条闸在新链路上**不再存在**。它必须在上传前由前端
// 自己判：`file.slice(0, 4)` 读出首 4 字节比对，xlsx 本质是 ZIP、magic 必然是那四个。
// 这是「把一条校验从后端挪到前端」而不是「新增一条校验」—— 后端那条在旧 multipart
// 链路上确实存在过，删掉端点就得有人接手，否则一份改名的 .txt 能进库、到打印那一刻
// 才炸。
//
// ⚠️ **版式（零件版 / 检具版）先探测、再按该版式逐格校验**：后端模板行的 `kind` 恒是
// `DELIVERY_TEMPLATE`、不带版式信息，所以「这份文件是哪一套版式」只能由前端从模板结构判定
// （`detectTemplateContract`）。判不出版式就直接拒收 —— 不知道该按哪套判据校验的文件没有
// 「逐格校验通过」这个概念。
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
  type ListPrintTemplatesParams,
} from '@/api/printTemplates';
import { directUpload } from '@/utils/directUpload';
import { qk } from '@/composables/queries/keys';
import { triggerBrowserDownload } from '@/utils/download';
import {
  assertTemplateMatches,
  detectTemplateContract,
} from '@/views/com/delivery/utils/deliveryNoteTemplate';
import { XLSX_MIME } from '@/views/com/delivery/utils/deliveryNoteTemplateContract';
import { PRINT_TEMPLATE_ACCEPT_EXT, type PrintTemplateData } from '../printTemplateSchema';
import { usePrintTemplateListQuery } from './usePrintTemplateListQuery';

/** 列表一次拉多少条。后端 clamp 上限比这大，但模板是配置数据、现实中一个 L1 就一行，
 *  给一个够用又不至于让「切客户」这一下拉回一整页的量。
 *
 * ⚠️ **本页刻意不翻页**（2026-10-16 review 第 1 轮 MINOR-13 复核）：后端的绑定维度是
 * 「一份模板 ↔ 一个一级客户」，同一 L1 二次上传是**替换**而不是新增 ⇒ `items` 的上界就是
 * 「库里有一级客户数」个量级，现实中到不了本常量。为了一个到不了的量级引入页码控件 / offset
 * 状态 / 页码与筛选的联动，比它挡住的问题更贵。
 *
 * ⚠️ 正因为「到不了」，**静默截断是不可接受的失败形态**：`total` 一旦与 `items.length`
 * 不一致就说明后端 clamp 上限被调低了。所以 `total` 必须上屏（见 `query.total` 的注释与
 * `PrintTemplateList.vue` 的工具栏），让截断当场可见，而不是等某个客户抱怨「他的模板不见了」。*/
const LIST_PAGE_SIZE = 200;

/** ZIP（也就是 xlsx）的首 4 字节 magic：`PK\x03\x04`。 */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

/**
 * 读首 4 字节判是不是 ZIP 包（2026-10-15）。
 *
 * 为什么必须是前端判：直传链路的 confirm 端点只拿到文件元数据、拿不到字节，后端那条
 * 「前 4 字节必须是 PK\x03\x04」的闸随 multipart 端点一起下线了。
 *
 * 用 `slice(0, 4)` 而不是 `arrayBuffer()`：只读 4 字节，一份几百 KB 的模板不必整份拷进
 * 内存。文件本身读不出来（极少见）时按「不是 ZIP」处理 —— 判据宁严勿松。
 */
async function isZipMagic(file: File): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return ZIP_MAGIC.every((b, i) => head[i] === b);
  } catch {
    return false;
  }
}

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
  /**
   * 后端返回的**总条数**（不受 `limit` 截断影响）。
   *
   * ⚠️ **这不是装饰字段、是一个可见性闸门**（2026-10-16 review 第 1 轮 MINOR-13）：本页不
   * 翻页（理由见 `LIST_PAGE_SIZE`），所以 `total > rows.length` 的唯一成因就是「后端 clamp
   * 上限被调低 / 将来绑定维度从一对一放宽」⇒ 那时表格会**静默截断**。把它渲染到工具栏，
   * 截断当场可见。
   *
   * ⚠️ **「共 N 个一级客户」这个页面文案依赖一条当前恰好成立的等价**（2026-10-16 review
   * 第 2 轮 M-6 登记）：`total` 数的是**模板行数**，页面却把它说成「一级客户数」。两者在
   * 「一份模板 ↔ 一个一级客户」的后端约束下相等（模板行数 = 已绑定的 L1 数），所以措辞
   * 现在成立。**绑定维度一旦放宽（一个 L1 多份模板），这个文案会先于数据出错** —— 那时要改
   * 的是这里与 `PrintTemplateList.vue` 的工具栏，不是 `LIST_PAGE_SIZE`。
   */
  const total = computed<number>(() => listQuery.data.value?.total ?? 0);
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
   * 差异原文逐条摆到页面上（`.upload-diffs`），用户据此看出自己改错了哪一格。判不出版式的
   * 那一支也写进这里（见 `uploadChecked`）：它同样意味着「这份文件不该入库」，走同一条
   * 可见通道比只弹一条转瞬即逝的 toast 可靠。
   */
  const uploadDiffs = ref<string[]>([]);
  /** 上传 / 校验中的整体 loading（表格与按钮共用一个，避免两个转圈互相盖住）。 */
  const busy = ref(false);

  const uploadMutation = useMutation({
    mutationKey: ['print-templates', 'upload'],
    // 2026-10-15：直传链路（upload-intents → XHR PUT → confirm），owner 是**一级客户**
    // （不是零件 / 装配件），kind 恒为 `DELIVERY_TEMPLATE`。
    mutationFn: (vars: { customerId: string; file: File }) =>
      directUpload({
        ownerKind: 'CUSTOMER',
        ownerId: vars.customerId,
        kind: 'DELIVERY_TEMPLATE',
        file: vars.file,
      }).then((r) => r.item),
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
   * ⚠️ **两段的失败必须分开归因**（2026-10-16 review 第 1 轮 MAJOR-2）：模板在 `mutateAsync`
   * 那一刻是**校验通过**的（第二道闸刚放行）。若把 `mutateAsync` 也塞进「校验」的
   * `try/catch`，请求失败（21103 超限 / 40300 权限 / 40901 版本冲突 / 网络断开）会落进
   * 那条 catch ⇒ ① `onError` 已弹过真实错误、这里再弹一条「模板解析失败」；②
   * `uploadDiffs` 被写成 API 错误文案，`PrintTemplateList.vue` 的 `el-alert` 渲染成
   * 「模板校验未通过，共 1 处差异」，正文是后端错误消息。报错完全指错方向：用户会去改
   * Excel 单元格，而真正原因是文件太大 / 权限 / 版本冲突。
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
      return await uploadChecked(file, targetCustomerId);
    } finally {
      busy.value = false;
    }
  }

  /**
   * `upload` 的真正实现（**busy 的 finally 由调用方管**，见上面那层）。
   *
   * ⚠️ 三段 try/catch 是刻意的分界：第二段只包「读字节 + 解 zip + 探版式 + 逐格比对」，
   * 第三段的请求失败**不允许**进第二段那个 catch（理由见 `upload` 的 doc）。
   *
   * ⚠️ **「上传逐格校验、打印只探测」是两件事**（2026-10-18）：这里（上传闸）是全仓**唯一**
   * 能在**入库前**拦住坏模板的时机 —— 打印对话框打开时那份模板已经过了这道闸，它只做
   * `detectTemplateContract` 的锚点探测（O(1) 二选一，判不出就禁导出），不做逐格校验。
   * 反过来把逐格校验搬到打印页也拦不住任何新东西，只会让「管理员在 Excel 里改了一格」变成
   * 要联系管理员才能打印。所以「逐条差异」这份清单**必须**留在这里。
   */
  async function uploadChecked(file: File, targetCustomerId: string): Promise<boolean> {
    // ---- 第二道闸：ZIP magic 切片校验（2026-10-15，职责从后端 confirm 端点移交过来）。
    // 只读首 4 字节（slice 不复制整份几十 KB..几百 KB 的文件），xlsx 是 ZIP ⇒ magic 恒为
    // `50 4B 03 04`。不合即拒：**在入库前**判掉，避免一份改名的 .txt 进了库、到打印那一刻
    // 才以「打开失败」的形式炸给用户。
    const isZip = await isZipMagic(file);
    if (!isZip) {
      uploadDiffs.value = [
        '文件头不是 ZIP（xlsx 本质是 ZIP 包）—— 很可能只是改了后缀名的其它格式，请用 Excel 另存为 .xlsx',
      ];
      ElMessage.error('模板不是有效的 xlsx（文件头校验未通过），已取消上传');
      return false;
    }

    // ---- 第三道闸：先探版式、再按该版式逐格比对。⚠️ 这一段单独一个 try/catch，**只有它**归
    // 「模板解析失败」—— 见上方 doc 说的「两段失败必须分开归因」。
    let diffs: string[];
    try {
      // ⚠️ 校验本身不能省 —— 一份列位错位的模板在库里是完全合法的，坏在打印那一刻才发现
      // 已经晚了。
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { openXlsx } = await import('hucre');
      const wb = await openXlsx(bytes);
      // 判不出版式 ⇒ 连「该按哪套逐格判据校验」都不知道，直接拒收（后端 `kind` 恒是
      // `DELIVERY_TEMPLATE`、不带版式信息，版式只能由前端从模板结构判定）。
      const contract = detectTemplateContract(wb);
      if (!contract) {
        uploadDiffs.value = [
          '这份模板既不匹配零件版、也不匹配检具版（模板编辑页只支持这两套版式）',
        ];
        ElMessage.error('模板版式不认识，已取消上传');
        return false;
      }
      diffs = await assertTemplateMatches(wb, contract);
    } catch (e) {
      uploadDiffs.value = [`模板解析失败：${(e as Error).message}`];
      ElMessage.error('模板解析失败，已取消上传');
      return false;
    }
    if (diffs.length > 0) {
      uploadDiffs.value = diffs;
      ElMessage.error(`模板校验未通过（${diffs.length} 处差异），已取消上传`);
      return false;
    }
    // ---- 第四段：请求。失败由 uploadMutation 的 onError 提示，这里只回落成 false ----
    // ⚠️ 回落而不是继续向上抛（2026-10-16 review 第 1 轮 MAJOR-2）：页面壳那侧是
    // `await store.upload.run(...)`，让 reject 冒出去就是一个未捕获的 rejection。真正给用户
    // 的提示由 mutation 的 `onError` 弹（**只弹那一次**），这里既不重复弹、也**不把 API
    // 错误文案写进 uploadDiffs** —— 那会让差异面板把「文件太大 / 无权限」渲染成
    // 「模板校验未通过」，把用户引去改 Excel 单元格而不是改文件大小。
    const ok = await uploadMutation
      .mutateAsync({ customerId: targetCustomerId, file })
      .then(() => true)
      .catch(() => false);
    return ok;
  }

  /** 正在下载的行 id（`null` = 无）。**按行**挂 loading：布尔量挂到每一行会让整张表的
   *  按钮一起转圈，看不出是哪一条在处理。 */
  const downloadingRowId = ref<string | null>(null);

  /**
   * 下载模板字节。
   *
   * ⚠️ 走 `fetchPrintTemplateContent`（axios、`baseURL=/api/v2`、带 Authorization 头），
   * 不拼任何相对路径：本域**没有**「把某条 URL 塞进 `<a href>`」的写法
   * （2026-10-16 review 第 2 轮 C-1：后端 resolve 出参里压根没有 `content_url` 字段，
   * 原先那段「不能用它因为它是相对路径」的注释描述的是幻觉）。
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
   *  ⚠️ 删除后**该一级客户就没有模板了**：打印对话框会自动选用失败，按钮禁用并提示去
   *  「模板编辑」页重新上传（打印页没有别的兜底入口），提示文案见对话框的 `exportHint`。 */
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
      /** 后端返回的总条数（`> rows.length` ⇒ 列表被后端 clamp 截断了，工具栏会显示出来）。 */
      total,
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
