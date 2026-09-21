// views/parts/detail/composables/useProcessChain.ts
//
// 2026-09-17 新增：PartDetail 拆分的 useProcessChain（PR-3 / 工序链卡片化重构配套）。
// 负责按 part.process_chain_id 加载工艺链（rust `GET /api/v2/process-chains/{chain_id}`），
// 暴露 chain / loading / steps / currentStepId / setSelectedBatchId / fetchProcessChain。
//
// 切 partId 时清空 chain / steps / selectedBatchId。
// 404（无链 / 链已删 → 20701 BIZ_PROCESS_CHAIN_NOT_FOUND）按空链兜底，不弹 ElMessage.error。
//
// 注：process_chain_id 是 part.process_chain_id（PR-3 引入），selectedBatchId
// 默认 null，由 PartBatchMonitorCard @row-click 写入；batches 来自 usePartDetail。

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import { getProcessChainById } from '@/api/processChain';
import type { ProcessChainByPartDto, ProcessChainStepDto } from '@/api/processChain.contract';
import type { PartItem, PartBatch } from '@/api/parts';

/** 2026-09-21 显式返回类型。 */
export interface UseProcessChainReturn {
  chain: Ref<ProcessChainByPartDto | null>;
  steps: Ref<ProcessChainStepDto[]>;
  loading: Ref<boolean>;
  /** 当前选中批次所在工艺链步骤 id（PR-3 强绑定 current_process_step_id）。 */
  currentStepId: ComputedRef<string | null>;
  setSelectedBatchId: (id: string | null) => void;
  fetchProcessChain: () => Promise<void>;
}

export function useProcessChain(
  partId: Ref<string>,
  part: Ref<PartItem | null>,
  batches: Ref<PartBatch[]>,
  selectedBatchId: Ref<string | null>,
): UseProcessChainReturn {
  const chain = ref<ProcessChainByPartDto | null>(null);
  const steps = ref<ProcessChainStepDto[]>([]);
  const loading = ref(false);

  /**
   * 当前选中批次所在的工艺链步骤 id（FK → t_process_chain_step.id；null =
   * 批次未绑定步骤或未选中）。
   * 2026-09-17 PR-3：PartBatch.current_process_step_id 替换旧 next_process_id，
   * 与工艺链步骤强绑定。 */
  const currentStepId = computed<string | null>(() => {
    if (!selectedBatchId.value) return null;
    const b = batches.value.find((x) => x.id === selectedBatchId.value);
    if (!b) return null;
    return b.current_process_step_id ?? null;
  });

  function setSelectedBatchId(id: string | null): void {
    selectedBatchId.value = id;
  }

  async function fetchProcessChain(): Promise<void> {
    // part 还没加载 / 拿不到 process_chain_id → 清空返回
    const chainId = part.value?.process_chain_id;
    if (!chainId) {
      chain.value = null;
      steps.value = [];
      return;
    }
    loading.value = true;
    try {
      const dto = await getProcessChainById(chainId);
      chain.value = dto;
      // 链后端按 sort_order ASC, id ASC 排序（process-chain.md §DTO），前端
      // 不再二次排序，直接使用。
      steps.value = dto.steps;
    } catch (e) {
      // 20701 BIZ_PROCESS_CHAIN_NOT_FOUND / 404：视为空链（part 尚未制定工艺）。
      // 其它错误：清空但不弹 ElMessage.error（详情页本身已经 ElMessage.error 过）。
      void e;
      chain.value = null;
      steps.value = [];
    } finally {
      loading.value = false;
    }
  }

  // 切换 partId 时重置
  watch(partId, () => {
    chain.value = null;
    steps.value = [];
    selectedBatchId.value = null;
  });

  return {
    chain,
    steps,
    loading,
    currentStepId,
    setSelectedBatchId,
    fetchProcessChain,
  };
}
