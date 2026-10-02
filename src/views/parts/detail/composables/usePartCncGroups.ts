// views/parts/detail/composables/usePartCncGroups.ts
//
// 2026-08-25 frontend-overall-refactor：PartDetail 拆分的 usePartCncGroups。
// 负责 CNC G 代码 + 设定单的拉取 / 下载 / 删除 / 配对上传 / 下发到 CNC 货架。
//
// composable 不持有 dialog 状态——配对上传 / 下发对话框的可见性 / 表单
// 状态由 PartCncCard 局部维护；提交时调用本 composable 暴露的纯函数。
//
// 2026-09-16 PR-3：releaseFromProgramming 后端新增前置校验 —— part.process_chain_id
// 非空，否则 20706 BIZ_PROCESS_CHAIN_REQUIRED。onReleaseToShelf 接 handleProcessChainRequired：
// 命中 → 弹「前往制定」确认框 → 跳 /production/process-design?part_id=XXX。
//
// 2026-09-29 修复：cncPrograms / setupSheets 改为从 usePartFilesListQuery 派生
//（owner 全量按 kind 桶），砍 1 个冗余 RTT（原本 listPartCncPrograms +
// listPartSetupSheets 两个独立 alias 端点）。download / delete / upload 改走
// part_file native 端点 / cnc-programs canonical pairs 端点。api/cnc.ts 仅
// 保留 uploadCncPair 一条函数。

import { computed, type ComputedRef, type Ref } from 'vue';
import { ElMessage, type UploadFile } from 'element-plus';
import { useRouter } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import { uploadCncPair } from '@/api/cnc';
import { deletePartFile, getPartFileDownloadUrl } from '@/api/parts/file';
import { releaseFromProgramming } from '@/api/parts';
import type { PartFileItem } from '@/types/part_file';
import { usePermissions } from '@/composables/usePermissions';
import { handleProcessChainRequired } from '@/composables/useProcessChainRequiredHandler';
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
  /** 2026-10-02：端点迁 prod 域后以批次为锚，故第一形参是 batchId（可空 = 未选中批次）。 */
  onReleaseToShelf: (
    batchId: string | null,
    shelfId: string,
    processId: string,
  ) => Promise<boolean>;
  fileList: (
    current: UploadFile[],
    file: UploadFile,
    accept: string,
    matchExt?: boolean,
  ) => UploadFile[];
}

export function usePartCncGroups(partId: Ref<string>): UsePartCncGroupsReturn {
  // 2026-09-17 PR-3 修复：useRouter() 必须在 setup 顶部一次性拿闭包复用，禁止在 async 事件回调里调
  // —— vue-router 4.6.4 + vue 3.5.38 下 inject() 在 lifecycle hook 之外返回 undefined。
  const router = useRouter();
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

  // 2026-09-29 修复：下载走 part_file native 端点（替代原 getCncDownloadUrl 走的
  // /cnc-programs/{id}/download-url alias）。
  async function onDownloadCnc(p: PartFileItem): Promise<void> {
    try {
      const url = await getPartFileDownloadUrl(p.id);
      window.open(url, '_blank');
    } catch (e) {
      ElMessage.error((e as Error).message ?? '获取下载链接失败');
    }
  }

  // 2026-09-29 修复：删除走 part_file native 端点（替代原 deleteCncProgram 走的
  // /cnc-programs/{id}/delete alias）。成功后 invalidate 整个 owner part-files
  // 列表，下游 computed (cncPrograms / setupSheets / drawings / models3d /
  // cadFiles) 自动 re-fetch + re-filter。
  async function onDeleteCnc(id: string, version: number): Promise<void> {
    try {
      await deletePartFile(id, version);
      ElMessage.success('已删除');
      await invalidatePartFilesListQuery(qc, partId.value);
    } catch (e) {
      ElMessage.error((e as Error).message ?? '删除失败');
    }
  }

  // 多文件 staging 助手（仿 PartBatchNew.vue:1803-1819）
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
   * 配对上传业务：逐个上传 G 代码 + 一次设定单（setup 走 SHA-256 dedup）。
   * 由 PartCncCard 调起，参数为 dialog 内收集的 raw File 列表。
   *
   * 2026-09-29 修复：uploadCncPair 已迁到 canonical `POST /api/v2/cnc-programs/pairs`
   * （field 重映射：gcode_file → g_code、setup_file → setup_sheet；新增 data
   * JSON 文本字段含 part_id）。成功后 invalidate owner part-files 列表让 UI
   * 自动 refresh pair 列表。
   */
  async function onPairUpload(rawGcodes: File[], setupFile: File): Promise<boolean> {
    if (rawGcodes.length === 0 || !setupFile) return false;
    try {
      for (const gcode of rawGcodes) {
        await uploadCncPair(partId.value, gcode, setupFile);
      }
      ElMessage.success(`配对上传成功（${rawGcodes.length} 个 G 代码 + 1 个设定单）`);
      await invalidatePartFilesListQuery(qc, partId.value);
      return true;
    } catch (e) {
      ElMessage.error((e as Error).message ?? '配对上传失败');
      return false;
    }
  }

  /**
   * 下发到 CNC 货架（PROGRAMMING → IN_PROCESS）。
   * 由 PartCncCard 在 release dialog 内调用：
   *   if (await onReleaseToShelf(shelfId, processId)) releaseVisible = false
   *
   * 2026-09-16 PR-3：releaseFromProgramming 后端新增 20706 校验；命中时
   * 弹「前往制定」确认框并跳工艺制定页，不走普通 ElMessage.error 兜底。
   *
   * 2026-10-02：release-from-programming 迁 prod 域并以批次为锚
   * （`POST /prod/batches/{batch_id}/release-from-programming`），batchId 由
   * PartDetail 用三卡联动已选中的批次传入；未选中时直接失败，不用 part_id 顶替。
   */
  async function onReleaseToShelf(
    batchId: string | null,
    shelfId: string,
    processId: string,
  ): Promise<boolean> {
    if (!batchId) {
      ElMessage.error('请先在批次列表中选中要下发的批次');
      return false;
    }
    try {
      await releaseFromProgramming(batchId, shelfId, processId);
      ElMessage.success('已下发到生产货架');
      return true;
    } catch (e) {
      const handled = await handleProcessChainRequired(e, partId.value, router);
      if (!handled) {
        ElMessage.error((e as Error).message ?? '下发失败');
      }
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
    onReleaseToShelf,
    fileList,
  };
}
