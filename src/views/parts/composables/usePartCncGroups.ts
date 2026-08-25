// views/parts/composables/usePartCncGroups.ts
//
// 2026-08-25 frontend-overall-refactor：PartDetail 拆分的 usePartCncGroups。
// 负责 CNC G 代码 + 设定单的拉取 / 下载 / 删除 / 配对上传 / 下发到 CNC 货架。
//
// composable 不持有 dialog 状态——配对上传 / 下发对话框的可见性 / 表单
// 状态由 PartCncCard 局部维护；提交时调用本 composable 暴露的纯函数。

import { computed, ref, watch, type Ref } from 'vue'
import { ElMessage, type UploadFile } from 'element-plus'
import {
  deleteCncProgram,
  getCncDownloadUrl,
  listPartCncPrograms,
  listPartSetupSheets,
  uploadCncPair,
} from '@/api/cnc'
import { releaseFromProgramming } from '@/api/parts'
import type { PartFileItem } from '@/types/part_file'
import { usePermissions } from '@/composables/usePermissions'

/** CNC 配对组：1 设定单 + 0~N 个 G 代码（setup=null 表示「未配对」桶） */
export interface CncSetupGroup {
  setup: PartFileItem | null
  gcodes: PartFileItem[]
}

export function usePartCncGroups(partId: Ref<string>) {
  const cncPrograms = ref<PartFileItem[]>([])
  const setupSheets = ref<PartFileItem[]>([])
  const cncLoading = ref(false)

  const { isManager, isCncProgrammer: isCnc } = usePermissions()
  const canManageCncFiles = computed(() => isManager.value || isCnc.value)
  const canManageSetupSheet = computed(() => isManager.value || isCnc.value)

  // 配对分组：先按 setup.id 排序（保留原列表顺序），未配对 gcode 走「未配对」桶
  const cncSetupGroups = computed<CncSetupGroup[]>(() => {
    const gcodeList = cncPrograms.value
    const setupList = setupSheets.value
    const setupById = new Map<string, PartFileItem>()
    for (const s of setupList) setupById.set(s.id, s)

    const bySetupId = new Map<string, PartFileItem[]>()
    const unpairedGcodes: PartFileItem[] = []
    for (const g of gcodeList) {
      if (g.paired_file_id && setupById.has(g.paired_file_id)) {
        const arr = bySetupId.get(g.paired_file_id) ?? []
        arr.push(g)
        bySetupId.set(g.paired_file_id, arr)
      } else {
        unpairedGcodes.push(g)
      }
    }

    const groups: CncSetupGroup[] = []
    for (const s of setupList) {
      groups.push({ setup: s, gcodes: bySetupId.get(s.id) ?? [] })
    }
    if (unpairedGcodes.length > 0) {
      groups.push({ setup: null, gcodes: unpairedGcodes })
    }
    return groups
  })

  async function fetchCncPrograms(): Promise<void> {
    cncLoading.value = true
    try {
      cncPrograms.value = await listPartCncPrograms(partId.value, 'G_CODE')
      setupSheets.value = await listPartSetupSheets(partId.value)
    } catch (e) {
      cncPrograms.value = []
      setupSheets.value = []
      ElMessage.error((e as Error).message ?? '加载 CNC 文件失败')
    } finally {
      cncLoading.value = false
    }
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(2)} MB`
  }

  async function onDownloadCnc(p: PartFileItem): Promise<void> {
    try {
      const url = await getCncDownloadUrl(p.id)
      window.open(url, '_blank')
    } catch (e) {
      ElMessage.error((e as Error).message ?? '获取下载链接失败')
    }
  }

  async function onDeleteCnc(id: string): Promise<void> {
    try {
      await deleteCncProgram(id)
      ElMessage.success('已删除')
      void fetchCncPrograms()
    } catch (e) {
      ElMessage.error((e as Error).message ?? '删除失败')
    }
  }

  // 多文件 staging 助手（仿 PartBatchNew.vue:1803-1819）
  function fileList(
    current: UploadFile[],
    file: UploadFile,
    accept: string,
    matchExt = false,
  ): UploadFile[] {
    if (current.some((f) => f.uid === file.uid)) return current
    if (matchExt) {
      const name = (file.name || '').toLowerCase()
      const exts = accept.replace(/\./g, '').split(',')
      if (!exts.some((e) => name.endsWith('.' + e))) {
        ElMessage.warning(`不支持的文件类型：${file.name}`)
        return current
      }
    }
    return [...current, file]
  }

  /**
   * 配对上传业务：逐个上传 G 代码 + 一次设定单（setup 走 SHA-256 dedup）。
   * 由 PartCncCard 调起，参数为 dialog 内收集的 raw File 列表。
   */
  async function onPairUpload(
    rawGcodes: File[],
    setupFile: File,
  ): Promise<boolean> {
    if (rawGcodes.length === 0 || !setupFile) return false
    try {
      for (const gcode of rawGcodes) {
        await uploadCncPair(partId.value, gcode, setupFile)
      }
      ElMessage.success(`配对上传成功（${rawGcodes.length} 个 G 代码 + 1 个设定单）`)
      void fetchCncPrograms()
      return true
    } catch (e) {
      ElMessage.error((e as Error).message ?? '配对上传失败')
      return false
    }
  }

  /**
   * 下发到 CNC 货架（PROGRAMMING → IN_PROCESS）。
   * 由 PartCncCard 在 release dialog 内调用：
   *   if (await onReleaseToShelf(shelfId, processId)) releaseVisible = false
   */
  async function onReleaseToShelf(
    shelfId: string,
    processId: string,
  ): Promise<boolean> {
    try {
      await releaseFromProgramming(partId.value, shelfId, processId)
      ElMessage.success('已下发到生产货架')
      return true
    } catch (e) {
      ElMessage.error((e as Error).message ?? '下发失败')
      return false
    }
  }

  watch(partId, () => {
    cncPrograms.value = []
    setupSheets.value = []
  })

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
  }
}
