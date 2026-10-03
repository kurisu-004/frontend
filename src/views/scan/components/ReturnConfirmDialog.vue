<!--
  ReturnConfirmDialog.vue

  放回流程「链已知」的单确认弹窗（2026-10-04 新增）。

  为什么存在：零件制定了工序链时，工人完成当前工序放回，**下一道工序是后端已知的**
  （行 VO 的 `chain_state === 'NEXT'` + `chain_next_process_id` / `chain_next_process_name`），
  推荐货架也已知（`GET /shelves/for-return` 里 `is_recommended` 那一条）。此时
  「选工序 → 点货架」两步纯重复劳动：工人点一下卡片、再点一次「完成」，中间没有任何
  决策。本弹窗把它们合成一次确认 —— 主文案直接告诉工人「下一道工序是什么、放到哪个架」，
  确认即放回。

  视觉与交互照 `ShelfPickerDialog.vue` 的 HMI 骨架（800px 弹窗 + 禁点遮罩/禁 ESC +
  `size="large"` 大按钮）。两点差异及理由：
    1. `:show-close="false"` —— 右上角 × 会绕过状态清理（关闭时不发任何业务事件，
       父组件留着上一次的推荐架），HMI 场景下也应强制走 footer 三选一。
    2. 多了「手动选择工序」次要按钮 —— 链是管理员配的，工人对「这一道真的该走链上
       下一道」有最终发言权（配错链 / 临时插单 / 工装临时改道）。保留兜底出口，
       点它回落 `ProcessPickerDialog` 走原三步路径。

  组件**零 `api/*` 依赖**、不 import 任何 store：下一工序与目标货架都由父组件算好后
  传入，本组件只负责把两段文案摆出来 + 抛三个事件。

  props:
    modelValue: boolean    // 弹窗可见
    processLabel: string   // 下一道工序标签，如「CUT-01 下料」（**必填**，不许空串）
    shelfLabel: string     // 目标货架 code，如「A-03」（**必填**，不许空串）
  emits:
    update:modelValue(v: boolean)
    confirm()             // 确认放回：写 pendingShelfId 后直接提交
    manual()              // 手动选择工序：关本窗 + 打开 ProcessPickerDialog
    cancel()              // 取消：关本窗 + 清空整次选择
-->
<template>
  <el-dialog
    :model-value="modelValue"
    title="确认放回"
    width="800px"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="chain-body">
      <p class="chain-text">下一道工序为 {{ processLabel }}，请将工件放到 {{ shelfLabel }} 货架</p>
      <p class="chain-hint">
        下一道工序与目标货架已按工序链自动确定。若与现场实际不符，请点「手动选择工序」重新指定。
      </p>
    </div>
    <template #footer>
      <el-button size="large" @click="onCancel">取消</el-button>
      <el-button type="default" plain size="large" class="manual-btn" @click="onManual">
        手动选择工序
      </el-button>
      <el-button type="primary" size="large" class="confirm-btn" :loading="busy" @click="onConfirm">
        确认放回
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

/** 下一道工序标签与目标货架 code 都声明成**必填**：主文案是工人照着执行的唯一依据，
 *  任一为空都渲染成「下一道工序为 ，请将工件放到  货架」这种病句，而文案本身没有任何
 *  兜底句式能救。唯一的消费方 `ScanReturnParts.vue` 保证两值非空（解析不出时它根本不
 *  开本窗，见 `openChainConfirm` 的三条兜底），所以「不许为空」提到编译期而不是靠
 *  运行时默认值兜。 */
const props = defineProps<{
  modelValue: boolean;
  /** 下一道工序标签，如「CUT-01 下料」 */
  processLabel: string;
  /** 目标货架 code，如「A-03」 */
  shelfLabel: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  /** 确认放回 */
  confirm: [];
  /** 手动选择工序（回退到工序选择） */
  manual: [];
  /** 取消整次放回 */
  cancel: [];
}>();

/** 已抛 confirm、等待父组件关窗期间的闩锁。父组件用 v-if 挂载本组件，点完即卸载，
 *  物理双击本落不到同一按钮上；闩锁是廉价纵深防御 —— HMI 上这是唯一一个「一下就能触发
 *  写操作」的大按钮，重复提交会让同一件放回两次（后端第二次必得 20507）。 */
const busy = ref(false);

/** 关窗时复位闩锁。当前唯一调用方用 v-if 挂载本组件（见 ScanReturnParts.vue），
 *  modelValue 转 false 时组件已经卸载、busy 随实例一起销毁 ⇒ 这条复位在当前路径上
 *  不会触发。保留它是为了让本组件在 v-show / 常驻挂载下同样成立：没有它，闩锁会跨次
 *  打开粘住 true，下次打开时确认按钮一直转 loading、点了没反应。 */
watch(
  () => props.modelValue,
  (v) => {
    if (!v) busy.value = false;
  },
);

function onConfirm(): void {
  if (busy.value) return;
  busy.value = true;
  emit('confirm');
}

function onManual(): void {
  emit('manual');
  emit('update:modelValue', false);
}

function onCancel(): void {
  emit('cancel');
  emit('update:modelValue', false);
}
</script>

<style lang="scss" scoped>
.chain-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 24px 8px 8px;
  text-align: center;
}
.chain-text {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  line-height: 1.5;
  color: var(--primary-color);
}
.chain-hint {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
}
.manual-btn {
  min-width: 200px;
  font-size: 16px;
  font-weight: 600;
}
.confirm-btn {
  min-width: 200px;
  font-size: 16px;
  font-weight: 600;
}
</style>
