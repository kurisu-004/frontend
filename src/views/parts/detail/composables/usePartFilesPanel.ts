// views/parts/detail/composables/usePartFilesPanel.ts
//
// 2026-10-10 新增：零件详情页「零件文件」面板的接线层。
//
// 它只做**装配**，不新增任何行为：把「文件列表 query（按 kind 派生三组）+ 三个 kind 的
// 上传适配器 + G 代码 / 设定单的分组」从 shell 搬到这里，让 `PartDetail.vue` 只留
// 「把返回值喂给 `PartFilesTabsCard`」这一件事。搬进来的四个既有 composable 各自
// 不变：
//   - `usePartFilesListQuery(partId)` —— owner 维度单查询，按 kind 在这里 filter
//     （原「三个并发」的写法已不存在；同一 queryKey 被 `usePartCncGroups` 共用，
//     按 queryKey 去重 ⇒ 不会多发一次请求）；
//   - `usePartFileUpload` × 3 —— `PartFilesTabsCard` 期望 `(ownerId, file)` 签名，
//     而 `upload(file)` 的 owner 已在 composable 闭包里，这里适配成兼容签名；
//   - `usePartCncGroups(partId)` —— G 代码 / 设定单分组与下载 / 删除 / 配对上传。
//
// ⚠️ 失效口径不变：上传 / 删除 / 配对上传由 `usePartCncGroups` 内部的 mutation
//   `onSuccess` 失效 `qk.partFilesList(partId)`；`onFileTabRefresh` 只在用户手动点某
//   个 tab 的刷新时再失效一次（queryKey 是 owner 维度，一次覆盖三个 kind，
//   PartFilesTabsCard 内部 tabs 与 DrawingPreviewPane 都会自动 refetch）。

import { computed, type Ref } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import {
  usePartFilesListQuery,
  invalidatePartFilesListQuery,
} from '@/composables/queries/usePartFilesListQuery';
import { usePartFileUpload } from '@/composables/usePartFileUpload';
import type { PartFileItem } from '@/types/part_file';
import { usePartCncGroups } from './usePartCncGroups';

/** `PartFilesTabsCard` 期望的上传签名（ownerId 由 composable 闭包持有，这里忽略）。 */
type UploadAdapter = (ownerId: string, file: File) => Promise<PartFileItem>;

export function usePartFilesPanel(partId: Ref<string>) {
  // 失效用的 queryClient。必须在 setup 阶段取（Pinia / vue-query 的 injection context）。
  const qc = useQueryClient();

  // ============ 文件列表（owner 维度单查询 → 按 kind 派生）============
  const partFilesQuery = usePartFilesListQuery(() => partId.value);
  const partFiles = computed(() => partFilesQuery.data.value?.items ?? []);
  const drawings = computed(() => partFiles.value.filter((f) => f.kind === 'DRAWING'));
  const models3d = computed(() => partFiles.value.filter((f) => f.kind === '3D_MODEL'));
  const cadFiles = computed(() => partFiles.value.filter((f) => f.kind === 'CAD_2D'));

  // ============ 三个 kind 的上传适配器 ============
  const drawingUploadComp = usePartFileUpload({ ownerPartId: partId, kind: 'DRAWING' });
  const model3dUploadComp = usePartFileUpload({ ownerPartId: partId, kind: '3D_MODEL' });
  const cadUploadComp = usePartFileUpload({ ownerPartId: partId, kind: 'CAD_2D' });
  const drawingUpload: UploadAdapter = (_ownerId, file) => drawingUploadComp.upload(file);
  const model3dUpload: UploadAdapter = (_ownerId, file) => model3dUploadComp.upload(file);
  const cadUpload: UploadAdapter = (_ownerId, file) => cadUploadComp.upload(file);

  // ============ G 代码 / 设定单 ============
  const {
    cncSetupGroups,
    cncLoading,
    fetchCncPrograms,
    formatBytes,
    onDownloadCnc,
    onDeleteCnc,
    onPairUpload,
    // 上传 staging 助手（含 ElMessage.warning 兜底），由 shell 经函数 prop 注入
    // PartFilesTabsCard。
    fileList,
  } = usePartCncGroups(partId);

  /** 零件文件 tabs 的手动刷新：失效整 owner 列表，让所有 active 消费者自动 refetch。 */
  async function onFileTabRefresh(_kind: 'DRAWING' | '3D_MODEL' | 'CAD_2D'): Promise<void> {
    await invalidatePartFilesListQuery(qc, partId.value);
  }

  return {
    drawings,
    models3d,
    cadFiles,
    drawingUpload,
    model3dUpload,
    cadUpload,
    onFileTabRefresh,
    cncSetupGroups,
    cncLoading,
    fetchCncPrograms,
    formatBytes,
    onDownloadCnc,
    onDeleteCnc,
    onPairUpload,
    fileList,
  };
}
