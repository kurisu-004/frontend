// views/parts/composables/usePartFiles.ts
//
// 2026-08-25 frontend-overall-refactor：PartDetail 拆分的 usePartFiles。
// 负责 drawing / 3D model / CAD 源文件三套文件列表的拉取。
//
// 上传 / 删除由 FileListCard 通过 props 传入的 apiUpload 自行处理，
// 本 composable 只暴露 `fetch*` 供 FileListCard @refresh 调用。

import { ref, watch, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import { listPartFiles } from '@/api/assembly'
import type { PartFileItem } from '@/types/part_file'

export function usePartFiles(partId: Ref<string>) {
  const drawings = ref<PartFileItem[]>([])
  const models3d = ref<PartFileItem[]>([])
  const cadFiles = ref<PartFileItem[]>([])

  async function fetchDrawings(): Promise<void> {
    try {
      drawings.value = await listPartFiles(partId.value, 'DRAWING')
    } catch (e) {
      drawings.value = []
      ElMessage.error((e as Error).message ?? '加载图纸列表失败')
    }
  }

  async function fetch3DModels(): Promise<void> {
    try {
      models3d.value = await listPartFiles(partId.value, '3D_MODEL')
    } catch (e) {
      models3d.value = []
      ElMessage.error((e as Error).message ?? '加载 3D 模型列表失败')
    }
  }

  async function fetchCadFiles(): Promise<void> {
    try {
      cadFiles.value = await listPartFiles(partId.value, 'CAD_2D')
    } catch (e) {
      cadFiles.value = []
      ElMessage.error((e as Error).message ?? '加载 CAD 源文件失败')
    }
  }

  // 切换 partId 时清空旧数据，避免在等待新数据期间显示上一个 part 的文件
  watch(partId, () => {
    drawings.value = []
    models3d.value = []
    cadFiles.value = []
  })

  return {
    drawings,
    models3d,
    cadFiles,
    fetchDrawings,
    fetch3DModels,
    fetchCadFiles,
  }
}
