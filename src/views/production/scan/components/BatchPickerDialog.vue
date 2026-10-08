<!--
  BatchPickerDialog.vue

  同一条码命中列表里多个批次时弹出（2026-08-02 接入）。
  用法（与报工台同目录范式一致）：
    props:  modelValue: boolean
            code: string                    -- 扫到的条码（用于标题）
            rows: BatchPickerRow[]          -- 命中的多个批次（结构最小型，见下方定义）
    emits:  update:modelValue(v)
            pick(row)                       -- 工人点某行触发；调用方负责后续选中 / 滚动 / 打开下一弹窗

  2026-10-10 留在本目录、不上提 `src/components/`：活体消费方**只有报工台三页**（取件 / 放回 /
  送检），而 `src/components/` 的判据是「零个域内依赖 + 多域复用」（`BatchCard.vue` 6 个跨域
  消费方才配得上）。本组件 import 了域内 `chainAccent`，上提反而造出一条
  `components/ → views/` 的反向依赖。局部 import，不进 `main.ts` 全局注册。

  单行点选即关弹窗（不可改）。卡片按批次号升序展示；显示 batch_no / 数量 /
  当前 holder 文本 / 下一工序。点击 emit('pick')，调用方按业务需要驱动后续动作。
  ⚠️ 「按批次号升序 / 显示 batch_no」**对本域三页都不成立**：报工台行 VO 是后端
  `ScanListItem`（17 字段，`scanPartRowSchema` 未声明 `batch_no`）
  ⇒ 卡片恒显「批次 1」、排序恒为恒等操作。要让报工台也显示批次号，须后端给
  `ScanListItem` 补该字段并在 schema 里声明。
  2026-10-03：行 VO 形态不同时（3 个判据键全不在的窄 VO）meta 行会整行隐藏而不是留一行
  空文案，详见 holderText 的注释。
  2026-10-09：批次行的左边框专供「有制定工序链且链指针未漂移」这一个语义（有链 = 绿，
  规则见 `chainAccent`）：3 个调用方都传 `ScanPartRowSchema`（该键必填），
  行缺这个键时落中性色。
-->

<template>
  <el-dialog
    :model-value="modelValue"
    :title="`扫描 ${code} 在当前列表有 ${rows.length} 个批次`"
    width="640"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <p class="hint">同一条码在当前列表里命中多个批次。请点击要操作的那一张卡片。</p>

    <div v-if="rows.length === 0" class="empty-state">
      <el-icon :size="48" color="#c0c4cc"><Box /></el-icon>
      <p>本条码无批次在当前列表，请刷新后再试。</p>
    </div>

    <div v-else class="batch-list">
      <el-card
        v-for="b in sortedRows"
        :key="b.batch_id || b.id"
        shadow="hover"
        :class="['batch-row', chainRowClass(b.has_process_chain)]"
        @click="onPick(b)"
      >
        <div class="batch-line">
          <span class="serial">{{ b.serial_no || b.drawing_no }}</span>
          <el-tag type="info" size="small" effect="plain"> 批次{{ b.batch_no ?? 1 }} </el-tag>
          <el-tag v-if="b.is_urgent" type="danger" size="small" effect="dark" class="urgent-pulse"
            >加急</el-tag
          >
          <span class="name">{{ b.name }}</span>
          <span class="qty">× {{ b.quantity }}</span>
        </div>
        <!-- 2026-10-03：整行按「有没有可显示的信息」条件渲染。holderText 返回空串
             （窄 VO 一个 holder 键都没有）且无下一工序时不留空行。 -->
        <div v-if="holderText(b) || b.next_process_name" class="batch-meta">
          <span v-if="holderText(b)" class="holder">
            <el-icon><Box /></el-icon>
            <span>{{ holderText(b) }}</span>
          </span>
          <span v-if="b.next_process_name" class="next"> 下一工序：{{ b.next_process_name }} </span>
        </div>
      </el-card>
    </div>

    <template #footer>
      <el-button size="large" @click="onCancel">取消</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Box } from '@element-plus/icons-vue';
import type { PartItem } from '@/api/parts';
import { chainRowClass } from '@/views/production/scan/chainAccent';

/**
 * 2026-10-04：props 收成「结构最小型」——**全部字段 optional**，只覆盖本组件模板 +
 * `holderText` 真正读到的键。取件 / 放回 / 送检三页传的行经 `scanPartRowSchema` 守门，
 * 直接把 `ScanPartRowSchema[]` 赋给本类型即可，调用点不需要 `as unknown as`。
 * 运行时行为零变化：模板、排序、`holderText` 判据一律不动。
 */
export interface BatchPickerRow {
  id?: string;
  batch_id?: string | null;
  batch_no?: number | null;
  is_urgent?: boolean;
  serial_no?: string | null;
  drawing_no?: string;
  name?: string;
  quantity?: number;
  /** 3 个 holder 判据键；报工台行只有 `location`（schema 显式声明、值恒 null） */
  current_holder_kind?: string | null;
  shelf_code?: string | null;
  worker_name?: string | null;
  outsource_company_name?: string | null;
  current_holder_display?: string | null;
  location?: string | null;
  next_process_name?: string | null;
  /** 2026-10-09 新增：报工台三页的行 VO 带它（后端 `ScanListItem` 的派生列），卡片
   *  左边框按它着色（有链 = 绿）。声明成 optional 是为守住本接口「全字段 optional」
   *  的既有约定（见上面 `BatchPickerRow` 的注释），不是后端可能不填。 */
  has_process_chain?: boolean;
}

const props = defineProps<{
  modelValue: boolean;
  code: string;
  rows: BatchPickerRow[];
}>();

const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  pick: [row: PartItem];
}>();

/** 批次号升序展示；缺 batch_no 时按 1 处理 */
const sortedRows = computed(() =>
  [...props.rows].sort((a, b) => {
    const ax = a.batch_no ?? 1;
    const bx = b.batch_no ?? 1;
    return ax - bx;
  }),
);

/** 显示卡片当前 holder：kind='shelf' 取货架码，'worker' 取工人名，'outsource_company' 取公司名。
 *
 *  3 个调用方（ScanReturnParts / ScanPickParts / ScanInspectParts）传的行都是后端
 *  `ScanListItem`，经 `scanPartRowSchema` 守门 —— 该 schema 显式声明了 `location`
 *  ⇒ **键恒在**，只是值恒为 null（报工台两个 service 不做 batch enrichment，
 *  `location` 恒 null），判据走 default 分支显示「未知位置」。
 *  3 个判据键一个都不在的行（窄 VO）⇒ 返回空串，模板把 meta 行整行隐藏；这是
 *  `BatchPickerRow` 全字段 optional 形态的兜底分支，无活体调用方。
 *
 *  判据刻意用「键在不在」（`in`）而不是「值是否 null」：`location` 值可合法为 null
 *  （尚未上架的 PENDING 批次），那种场景必须继续显示「未知位置」，否则报工台的既有
 *  卡片会少一行信息。代价是这个判据**依赖后端不给 `location` 加 `skip_serializing_if`
 *  以及前端 schema 不 strip 掉该键** —— 一旦破坏，报工台卡片静默少掉这一行。 */
function holderText(p: BatchPickerRow): string {
  switch (p.current_holder_kind) {
    case 'shelf':
      return p.shelf_code ? `货架 ${p.shelf_code}` : '货架 —';
    case 'worker':
      return p.worker_name ? `工人 ${p.worker_name}` : '工人 —';
    case 'outsource_company':
      return p.outsource_company_name ? `外协 ${p.outsource_company_name}` : '外协 —';
    default:
      if (!('current_holder_kind' in p || 'current_holder_display' in p || 'location' in p)) {
        return '';
      }
      return p.current_holder_display ?? p.location ?? '未知位置';
  }
}

function onPick(row: BatchPickerRow): void {
  // pick 出口仍是 `PartItem`，与三页 handler（`onBatchPicked` / `onPickerBatchPicked`）
  // 的声明一致；报工台三页入口各做一次 `as unknown as ScanPartRowSchema` 把这一行
  // 认回本域的行类型。
  // 改进方向：上 `<script setup generic="T extends BatchPickerRow">` + `pick: [row: T]`，
  // 让出口载荷跟随调用方的行类型（报工台三页的 cast 随之消失），而不是继续加 cast。
  emit('pick', row as unknown as PartItem);
  emit('update:modelValue', false);
}

function onCancel(): void {
  emit('update:modelValue', false);
}
</script>

<style lang="scss" scoped>
.hint {
  margin: 0 0 16px;
  color: #606266;
  font-size: 14px;
}
.batch-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 60vh;
  overflow-y: auto;
}
.batch-row {
  display: flex !important;
  flex-direction: column;
  gap: 8px;
  padding: 14px 18px !important;
  border: 1px solid #e4e7ed;
  /* 左边框底色与另外三边同色；链语义绿由下面的 `.batch-row.has-chain` 覆盖
     （排在 `:hover` 之后：hover 的 `border-color` 与它同为 0,2,0，靠源码顺序取胜，
     保证 hover 时左边框也不被染蓝）。 */
  border-left: 4px solid #e4e7ed;
  border-radius: 8px;
  cursor: pointer;
  background: #fff;
  transition:
    border-color 0.15s,
    background 0.15s,
    box-shadow 0.15s;
}
.batch-row:hover {
  box-shadow: 0 2px 12px rgba(64, 158, 255, 0.12);
  border-color: #409eff;
}
/* 左边框 = 链语义（有制定工序链且链指针未漂移），EP 语义绿的字面值 */
.batch-row.has-chain {
  border-left-color: #67c23a;
}
.batch-line {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.batch-meta {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 13px;
  color: #606266;
  flex-wrap: wrap;
}
.serial {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 18px;
  font-weight: 700;
  color: #303133;
}
.name {
  font-size: 14px;
  color: #303133;
}
.qty {
  color: #409eff;
  font-weight: 700;
}
.holder {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #909399;
}
.next {
  color: #67c23a;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 64px 0;
  gap: 12px;
  color: #606266;
  p {
    margin: 0;
  }
}

@keyframes urgentPulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.6;
  }
}
.urgent-pulse {
  animation: urgentPulse 1.2s ease-in-out infinite;
}
</style>
