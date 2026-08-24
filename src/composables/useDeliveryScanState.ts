// composables/useDeliveryScanState.ts
//
// 扫码建单页 L1 客户选择持久化（2026-08-23 新增）。
//
// 背景：
//   - DeliveryNoteScan.vue 旧实现 l1CustomerId 是裸 ref，每次离开页面再
//     回来都要重选（原实现 :67 注释也明确写了「本次不做 URL 持久化」）。
//   - 现场扫码台是工位机，单用户长期使用，应在退出页面后保持上次选项。
//
// 形态：
//   - 模块级 composable 单例（同 useBarcodeScanner / useAuthSession / usePrintedLabels
//     风格，详见 CLAUDE.md §状态管理）。
//   - localStorage key = 'delivery_scan_l1_v1'（带 _v1 便于将来形状变更时灰度切换）；
//     内容 `{ l1CustomerId: string }` JSON 字符串。
//
// 容错：
//   - localStorage 读 / 写失败（quota exceeded / 隐私模式 disabled / JSON 损坏）全部
//     静默吞掉；扫码台不能因持久化失败而阻塞选客户。
//   - JSON 损坏 / 非对象 → 落回空字符串。

import { ref, type Ref } from 'vue'

const KEY = 'delivery_scan_l1_v1'

interface Persisted {
  l1CustomerId: string
}

function readPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { l1CustomerId: '' }
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Partial<Persisted>
      return {
        l1CustomerId: typeof obj.l1CustomerId === 'string' ? obj.l1CustomerId : '',
      }
    }
    return { l1CustomerId: '' }
  } catch {
    return { l1CustomerId: '' }
  }
}

function persist(data: Persisted): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data))
  } catch {
    /* quota / 隐私模式 / disabled — 静默忽略 */
  }
}

/** 模块级 ref，所有调用方共享同一份响应式状态。 */
const _l1CustomerId: Ref<string> = ref('')
/** 是否已从 localStorage 初始化（避免 setup 期 ref('') 触发 watch 误清空）。 */
const _loaded: Ref<boolean> = ref(false)

export function useDeliveryScanState() {
  /** 从 localStorage 读初始值；调用方在 onMounted 顶部调一次。 */
  function init(): void {
    if (_loaded.value) return
    const persisted = readPersisted()
    _l1CustomerId.value = persisted.l1CustomerId
    _loaded.value = true
  }

  function setL1CustomerId(id: string): void {
    _l1CustomerId.value = id
    persist({ l1CustomerId: id })
  }

  function clear(): void {
    _l1CustomerId.value = ''
    try {
      localStorage.removeItem(KEY)
    } catch {
      /* 静默忽略 */
    }
  }

  return {
    l1CustomerId: _l1CustomerId,
    setL1CustomerId,
    clear,
    init,
  }
}
