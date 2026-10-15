// views/parts/detail/composables/usePartCncGroups.ts
//
// 2026-08-25 frontend-overall-refactor：PartDetail 拆分的 usePartCncGroups。
// 负责 CNC G 代码 + 设定单的拉取 / 下载 / 删除 / 配对上传。
//
// composable 不持有 dialog 状态——配对上传对话框的可见性 / 表单
// 状态由 PartCncCard 局部维护；提交时调用本 composable 暴露的纯函数。
//
// 2026-10-10：`onReleaseToShelf`（下发到 CNC 货架）与它依赖的
// handleProcessChainRequired 一并删除 —— 该功能已由扫码台的工人放回 / 送检接管。
//
// 2026-09-29 修复：cncPrograms / setupSheets 改为从 usePartFilesListQuery 派生
//（owner 全量按 kind 桶），砍 1 个冗余 RTT（原本 listPartCncPrograms +
// listPartSetupSheets 两个独立 alias 端点）。download / delete 改走文件对象 native 端点
//（`GET /files/objects/{id}/url`、`POST /files/objects/{id}/delete`）。
//
// 2026-10-15：配对上传从 `POST /files/cnc/pairs`（multipart 一次带两份文件）改为
// 直传链路（`utils/directUpload.ts`：upload-intents → XHR PUT → confirm），配对关系
// 由 confirm 的 `pair_with_file_id` 表达；`api/files/cnc.ts` 随之整文件删除。
//
// 2026-10-13 files 域重组：download / delete 两条端点硬切 `/part-files/*` →
// `/files/objects/*`（旧路径 404、无 alias）。下方注释里提到的 4 条 cnc alias 端点
// （download-url / delete 等）已被后端删除。

import { computed, type ComputedRef, type Ref } from 'vue';
import { ElMessage, type UploadFile } from 'element-plus';
import { useQueryClient } from '@tanstack/vue-query';
import { deletePartFile, getPartFileDownloadUrl } from '@/api/files/objects';
import { directUpload } from '@/utils/directUpload';
import type { PartFileItem } from '@/types/part_file';
import { usePermissions } from '@/composables/usePermissions';
import {
  usePartFilesListQuery,
  invalidatePartFilesListQuery,
} from '@/composables/queries/usePartFilesListQuery';

/** CNC 配对组：1 设定单 + 0~N 个 G 代码（setup=null 表示「未配对」桶） */
export interface CncSetupGroup {
  setup: PartFileItem | null;
  gcodes: PartFileItem[];
}

/** 2026-09-21 显式返回类型。 */
export interface UsePartCncGroupsReturn {
  cncPrograms: ComputedRef<PartFileItem[]>;
  setupSheets: ComputedRef<PartFileItem[]>;
  cncLoading: ComputedRef<boolean>;
  cncSetupGroups: ComputedRef<CncSetupGroup[]>;
  canManageCncFiles: ComputedRef<boolean>;
  canManageSetupSheet: ComputedRef<boolean>;
  fetchCncPrograms: () => Promise<void>;
  formatBytes: (v: string | number) => string;
  onDownloadCnc: (p: PartFileItem) => Promise<void>;
  onDeleteCnc: (id: string, version: number) => Promise<void>;
  onPairUpload: (rawGcodes: File[], setupFile: File) => Promise<boolean>;
  fileList: (
    current: UploadFile[],
    file: UploadFile,
    accept: string,
    matchExt?: boolean,
  ) => UploadFile[];
}

export function usePartCncGroups(partId: Ref<string>): UsePartCncGroupsReturn {
  const qc = useQueryClient();

  // 2026-09-29 修复：单 useQuery 拉 owner 全量（reactive params 沿
  // 2026-09-26 TanStack Query 约定 #5）。cncPrograms / setupSheets 改
  // computed filter kind 派生，避免额外 RTT。
  // 注意：PartDetail.vue 也持有同名 usePartFilesListQuery(partId) ——
  // TanStack Query 按 queryKey 自动去重（qk.partFilesList(partId) 共享
  // 同一缓存条目），不会触发第二次 fetch；多 subscriber 共享同一份 data。
  const partFilesQuery = usePartFilesListQuery(() => partId.value);
  const cncPrograms = computed<PartFileItem[]>(() =>
    (partFilesQuery.data.value?.items ?? []).filter((f) => f.kind === 'G_CODE'),
  );
  const setupSheets = computed<PartFileItem[]>(() =>
    (partFilesQuery.data.value?.items ?? []).filter((f) => f.kind === 'SETUP_SHEET'),
  );
  // 2026-09-29 修复：cncLoading 暴露 isFetching 让 PartFilesTabsCard v-loading
  // 仍能正确显示（替代原 fetchCncPrograms 内的 ref<boolean>）。
  const cncLoading = computed<boolean>(() => partFilesQuery.isFetching.value);

  const { isManager, isCncProgrammer: isCnc } = usePermissions();
  const canManageCncFiles = computed(() => isManager.value || isCnc.value);
  const canManageSetupSheet = computed(() => isManager.value || isCnc.value);

  // 配对分组：先按 setup.id 排序（保留原列表顺序），未配对 gcode 走「未配对」桶
  const cncSetupGroups = computed<CncSetupGroup[]>(() => {
    const gcodeList = cncPrograms.value;
    const setupList = setupSheets.value;
    const setupById = new Map<string, PartFileItem>();
    for (const s of setupList) setupById.set(s.id, s);

    const bySetupId = new Map<string, PartFileItem[]>();
    const unpairedGcodes: PartFileItem[] = [];
    for (const g of gcodeList) {
      if (g.paired_file_id && setupById.has(g.paired_file_id)) {
        const arr = bySetupId.get(g.paired_file_id) ?? [];
        arr.push(g);
        bySetupId.set(g.paired_file_id, arr);
      } else {
        unpairedGcodes.push(g);
      }
    }

    const groups: CncSetupGroup[] = [];
    for (const s of setupList) {
      groups.push({ setup: s, gcodes: bySetupId.get(s.id) ?? [] });
    }
    if (unpairedGcodes.length > 0) {
      groups.push({ setup: null, gcodes: unpairedGcodes });
    }
    return groups;
  });

  /**
   * 2026-09-29 修复：fetchCncPrograms 改为 partFilesQuery.refetch()
   * 别名（沿 CLAUDE.md 2026-09-26 #7 fetchList 别名约定）。外部 caller
   *（PartFilesTabsCard @fetch / PartDetail 切 partId 后 / onMounted）
   * 零改动可用。
   */
  async function fetchCncPrograms(): Promise<void> {
    await partFilesQuery.refetch();
  }

  // 2026-09-16：v2 file_size 为 string（i64 雪花序列化器），入参兼容 string | number
  function formatBytes(v: string | number): string {
    const n = Number(v);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  // 2026-09-29 修复：下载走文件对象 native 端点 `GET /files/objects/{id}/url`
  // （替代原 getCncDownloadUrl 走的 /cnc-programs/{id}/download-url alias，
  // 该 alias 端点 2026-10-13 已被后端删除、旧路径 404）。
  async function onDownloadCnc(p: PartFileItem): Promise<void> {
    try {
      const url = await getPartFileDownloadUrl(p.id);
      window.open(url, '_blank');
    } catch (e) {
      ElMessage.error((e as Error).message ?? '获取下载链接失败');
    }
  }

  // 2026-09-29 修复：删除走文件对象 native 端点 `POST /files/objects/{id}/delete`
  // （替代原 deleteCncProgram 走的 /cnc-programs/{id}/delete alias，该 alias 端点
  // 2026-10-13 已被后端删除、旧路径 404）。成功后 invalidate 整个 owner 文件列表
  // query（queryKey 前缀 `part-files` 保持不变 —— 它是 TanStack 缓存键不是 URL，
  // 改名会让所有已缓存列表失效并触发全量重取），下游 computed (cncPrograms /
  // setupSheets / drawings / models3d / cadFiles) 自动 re-fetch + re-filter。
  async function onDeleteCnc(id: string, version: number): Promise<void> {
    try {
      await deletePartFile(id, version);
      ElMessage.success('已删除');
      await invalidatePartFilesListQuery(qc, partId.value);
    } catch (e) {
      ElMessage.error((e as Error).message ?? '删除失败');
    }
  }

  // 多文件 staging 助手：按 uid 去重后把新文件追加进当前列表；matchExt 为真时先按
  // accept 的扩展名白名单收窄，不中则 warning 并原样返回（不污染当前列表）。
  function fileList(
    current: UploadFile[],
    file: UploadFile,
    accept: string,
    matchExt = false,
  ): UploadFile[] {
    if (current.some((f) => f.uid === file.uid)) return current;
    if (matchExt) {
      const name = (file.name || '').toLowerCase();
      const exts = accept.replace(/\./g, '').split(',');
      if (!exts.some((e) => name.endsWith('.' + e))) {
        ElMessage.warning(`不支持的文件类型：${file.name}`);
        return current;
      }
    }
    return [...current, file];
  }

  /**
   * 配对上传业务：对每个 G 代码依次传 G_CODE + SETUP_SHEET 两个文件。
   * 由 PartCncCard 调起，参数为 dialog 内收集的 raw File 列表。
   *
   * 2026-10-15：改走直传链路（upload-intents → XHR PUT → confirm），配对关系由
   * confirm 的 `pair_with_file_id` 表达。两个方向不能反：配对是**有向的**，
   *   1. G_CODE 先单独传完（confirm **不带** `pair_with_file_id`），拿到它的文件行 id；
   *   2. SETUP_SHEET 再传，confirm 时带 `pair_with_file_id: gFile.id`。
   * 反过来（先传设定单）拿不到 G_CODE 的 id，配不上。N 个 G 代码共用**同一份**
   * SETUP_SHEET，即设定单只传一次、与第一个 G 代码配对 —— 后端按 (part, kind) 唯一，
   * 同一份设定单传第二遍必撞 21108。
   *
   * ⚠️ **配对只在真的走完 confirm 时才成立**（秒传短路那一支不发 confirm，
   * `pair_with_file_id` 不上行 ⇒ 库里两行都是未配对）：所以设定单命中秒传时本函数
   * **抛错**而不是按成功收。详见第 2 步的注释。
   */
  async function onPairUpload(rawGcodes: File[], setupFile: File): Promise<boolean> {
    if (rawGcodes.length === 0 || !setupFile) return false;
    const ownerId = partId.value;
    try {
      for (const gcode of rawGcodes) {
        // 1) G 代码：单独传，拿到文件行 id 作为配对锚。
        const gRes = await directUpload({
          ownerKind: 'PART',
          ownerId,
          kind: 'G_CODE',
          file: gcode,
        });
        // 2) 设定单：confirm 时带上 G 代码的文件 id 完成配对。
        //
        // ⚠️ **秒传命中必须当成失败抛出去，不能按成功收**（2026-10-15）：秒传短路那一支
        // **不发 confirm**（`utils/directUpload.ts::takeInstant`），`pair_with_file_id`
        // 根本不会上行；而后端 confirm 走 (owner, kind, sha) 兜底时只是**返回那一行既有
        // 行**、不做 pair 互写 ⇒ 库里两行 `paired_file_id` 都还是 null。读侧
        // （`cncSetupGroups`）正是靠它配对的 ⇒ 用户看到的是「新传的 G 代码 + 未配对桶里的
        // 旧设定单」，而界面上一切正常。
        //
        // 「补发一次 confirm」救不回来（那条路不做互写），所以这里唯一的诚实处置是显式失败：
        // 让用户知道这份设定单没有和 G 代码绑上，而不是弹一句「配对上传成功」。
        const sRes = await directUpload({
          ownerKind: 'PART',
          ownerId,
          kind: 'SETUP_SHEET',
          file: setupFile,
          pairWithFileId: gRes.item.id,
        });
        if (sRes.alreadyExists) {
          throw new Error(
            '设定单与库里已有的一份内容完全相同（秒传命中），本次没能把它与刚传的 G 代码配对。' +
              '请先删除那份旧的设定单，或换一份设定单后重试。',
          );
        }
      }
      ElMessage.success(`配对上传成功（${rawGcodes.length} 个 G 代码 + 1 个设定单）`);
      await invalidatePartFilesListQuery(qc, ownerId);
      return true;
    } catch (e) {
      ElMessage.error((e as Error).message ?? '配对上传失败');
      return false;
    }
  }

  return {
    cncPrograms,
    setupSheets,
    cncLoading,
    cncSetupGroups,
    canManageCncFiles,
    canManageSetupSheet,
    fetchCncPrograms,
    formatBytes,
    onDownloadCnc,
    onDeleteCnc,
    onPairUpload,
    fileList,
  };
}
