// views/parts/composables/usePartFiles.ts
//
// 2026-08-25 frontend-overall-refactor：PartDetail 拆分的 usePartFiles。
// 负责 drawing / 3D model / CAD 源文件三套文件列表的拉取。
//
// 2026-09-16 T3.5：列表端点切到 v2 `/part-files?owner_id=...&kind=...`（owner 多态）；
// 旧 `listPartFiles(partId, kind)` 保留为 `listPartFilesByOwner` 的 deprecation alias，
// 这里直接用具名版本。
//
// 上传 / 删除由 FileListCard 通过 props 传入的 apiUpload / apiDelete 自行处理，
// 本 composable 只暴露 `fetch*` 供 FileListCard @refresh 调用。

import { ref, watch, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { listPartFilesByOwner } from '@/api/assembly';
import type { PartFileItem } from '@/types/part_file';

export function usePartFiles(partId: Ref<string>) {
  const drawings = ref<PartFileItem[]>([]);
  const models3d = ref<PartFileItem[]>([]);
  const cadFiles = ref<PartFileItem[]>([]);

  async function fetchDrawings(): Promise<void> {
    try {
      // 2026-09-16 T3.5：走 /part-files?owner_id=...&kind=DRAWING
      drawings.value = (await listPartFilesByOwner(partId.value, 'DRAWING')).items;
    } catch (e) {
      drawings.value = [];
      ElMessage.error((e as Error).message ?? '加载图纸列表失败');
    }
  }

  async function fetch3DModels(): Promise<void> {
    try {
      models3d.value = (await listPartFilesByOwner(partId.value, '3D_MODEL')).items;
    } catch (e) {
      models3d.value = [];
      ElMessage.error((e as Error).message ?? '加载 3D 模型列表失败');
    }
  }

  async function fetchCadFiles(): Promise<void> {
    try {
      cadFiles.value = (await listPartFilesByOwner(partId.value, 'CAD_2D')).items;
    } catch (e) {
      cadFiles.value = [];
      ElMessage.error((e as Error).message ?? '加载 CAD 源文件失败');
    }
  }

  // 切换 partId 时清空旧数据，避免在等待新数据期间显示上一个 part 的文件
  watch(partId, () => {
    drawings.value = [];
    models3d.value = [];
    cadFiles.value = [];
  });

  return {
    drawings,
    models3d,
    cadFiles,
    fetchDrawings,
    fetch3DModels,
    fetchCadFiles,
  };
}
