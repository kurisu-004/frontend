<!--
  SystemDeliveryOrdersPanel.vue
  dashboard 右栏两块交期面板的共用展示壳（variant 三选一）：
    - variant="upcoming" 「今天及以后到期」：服务端 system_delivery_date >= today（含今天）
      且**一件都没交过**的工单（与 is_urgent 加急无关，加急只是行底色）
    - variant="overdue"  「已逾期未交」：服务端 system_delivery_date < today 且**一件都
      没交过**的工单
    - variant="partial"  「部分已交」：服务端**无时间窗口限制**、已交过一部分的工单

  数据源是 GET /dashboard/snapshot 的 `system_delivery_orders.{upcoming,overdue,partial}`：
  分桶、排序、每桶 30 条截断**全部在服务端**，本组件只负责渲染、不再判口径、不再 slice。

  行源（2026-10-10）：**工单级** —— t_part 排除子件 + t_assembly，装配件**替换**其子件
  行出现（子件不再单独出行）。行的 quantity / delivered_quantity 单位随 `row_type` 变：
  PART = 件、ASSEMBLY = 套（装配件级的「已交」是已交**套数**）。数量列 tooltip 据此分流
  单位文案。**桶归属不由前端判**（服务端按有无已交批次分好）⇒ 装配件可能落在 partial 桶
  却 delivered_quantity === 0（每个子件都交了 40%、凑不满整一套），本组件不得据该值重分桶。

  桶值是 `{ items, total }` 信封：total 是匹配总行数、不受 30 条截断影响，header 据此
  出「共 N 条，另有 M 条未显示」—— upcoming 桶无时间上界，几百条只显示最早 30 条是常态，
  用户无从知道被砍了多少。

  行内 6 列 —— 序列号 / 名称 / 数量 / 二级客户 / 状态 / 系统交期：
    - 名称与二级客户两列窄屏下 ellipsis 截断，tooltip 常显兜底（不做溢出检测：
      行高会随内容抖动）。系统交期只出日期；临近橙 / 逾期红由 deliveryUrgencyClass
      驱动 —— overdue 桶天然产出 overdue 类，样式表必须有该分支，否则逾期行静默退成灰。
      system_delivery_date 可空（partial 桶无窗口、明确含该列为 NULL 的工单，排序
      NULLS LAST）⇒ 空日期渲染「—」占位，不留一个看不出是空还是缺列的空白格。
    - 数量列：upcoming / overdue 出纯总量；partial 出「已交 / 总量」，已交部分走主题色，
      并包 el-tooltip 显式标注单位与含义。
      partial 的两个数字不做静默截断 —— 轨宽按 4 位 ×2 留足，溢出会带省略号可见。

  行可点性由 `rowClickable` 谓词下发（缺省全可点）：不可点的行去掉 pointer 光标、
  不吃 hover 高亮、且不 emit rowClick —— 组件不知道「为什么」不可点（当前是角色闸门），
  只负责把「不可点」呈现出来，避免出现「看着能点、点了没反应」的行。

  布局：行宽分三档，用容器查询而非视口媒体查询（见 .list-rows 的 container-type）。
  `.urgent` 红底**所有变体都有** —— 「加急」是工单自身的标记，与交期分桶无关。

  #header-extra slot：供父组件往 header 里插控件（当前是 upcoming / overdue 的 radio
  双档切换）。本组件只渲染、不持有分档状态，保持「只渲染、不判口径、不 slice」的职责边界。

  ⚠️ **已知风险（未修，待观感调优轮）**：header 变成两行后每卡头部多占约 26px，而
  `.el-card__header` 是 `flex-shrink: 0`、`.list-card` 的 `min-height` 仍是 160px ⇒
  右栏内容硬地板比 .list-card 注释里记的「160×2 + 16 = 336px」实际更高，矮视口下
  双列布局仍无滚动路径（超出部分被裁）。重算 min-height 预算需配合实测，本次只登记。
-->
<template>
  <el-card shadow="never" class="list-card">
    <template #header>
      <div class="list-header">
        <span class="list-title">
          <el-icon><component :is="titleIcon" /></el-icon>
          <span>{{ titleText }}</span>
        </span>
        <span class="list-subtitle">{{ subtitleText }}</span>
      </div>
      <div v-if="truncatedHint || $slots['header-extra']" class="list-header-extra">
        <span v-if="truncatedHint" class="list-truncated">{{ truncatedHint }}</span>
        <slot name="header-extra" />
      </div>
    </template>

    <div v-if="items.length === 0" class="list-empty">
      <el-empty :image-size="60" :description="emptyText" />
    </div>

    <div v-else class="list-rows">
      <div
        v-for="item in items"
        :key="item.id"
        :class="['row', { urgent: item.is_urgent, 'row--locked': !isRowClickable(item) }]"
        @click="onRowClick(item)"
      >
        <span class="row-serial">{{ item.serial_no ?? '—' }}</span>
        <el-tooltip :content="item.name" placement="top" :show-after="200" :disabled="!item.name">
          <span class="row-name">{{ item.name }}</span>
        </el-tooltip>
        <span v-if="!isPartialVariant" class="row-qty">{{ item.quantity }}</span>
        <el-tooltip
          v-else
          :content="deliveredTooltip(item)"
          placement="top"
          :show-after="200"
        >
          <span class="row-qty row-qty--partial">
            <span class="row-qty-done">{{ item.delivered_quantity }}</span>
            <span class="row-qty-sep">/</span>
            <span>{{ item.quantity }}</span>
          </span>
        </el-tooltip>
        <el-tooltip
          :content="item.customer_name ?? ''"
          placement="top"
          :show-after="200"
          :disabled="!item.customer_name"
        >
          <span class="row-customer">{{ item.customer_name ?? '—' }}</span>
        </el-tooltip>
        <el-tag :type="ORDER_STATUS_TAG_TYPE[item.status]" size="small" effect="plain">
          {{ ORDER_STATUS_LABEL[item.status] }}
        </el-tag>
        <span :class="['row-due', deliveryUrgencyClass(item.system_delivery_date)]">
          {{ formatDeliveryDate(item.system_delivery_date) || '—' }}
        </span>
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
// 2026-10-10：variant 拆 upcoming / overdue / partial 三档，行源改工单级（含装配件父行），
// 桶值改 {items, total} 信封，header 出截断提示并开 #header-extra slot。
// el-tooltip / el-tag / el-card / el-icon / el-empty 不 import：由 vite.config.ts 的
// unplugin-vue-components + ElementPlusResolver 自动注册（样式同理自动注入）。

import { computed } from 'vue';
import { Bell, GoodsFilled, WarningFilled } from '@element-plus/icons-vue';
import { deliveryUrgencyClass, formatDeliveryDate } from '@/utils/deliveryDate';
import { ORDER_STATUS_LABEL, ORDER_STATUS_TAG_TYPE } from '@/types/parts';
import type { SystemDeliveryOrderData } from '@/views/dashboard/composables/dashboardSnapshotSchema';

const props = defineProps<{
  /** 变体：upcoming = 今天及以后到期且没交过；overdue = 已逾期且没交过；
   *  partial = 已交过一部分（不限时间）。 */
  variant: 'upcoming' | 'overdue' | 'partial';
  /** 该桶匹配的行（`snapshot.system_delivery_orders.<variant>.items`）。
   *  **组件不再 slice**：上限由服务端定，重复截断只会让 header 的「共 N 条」与实际行数
   *  在服务端放宽上限时对不上。 */
  items: SystemDeliveryOrderData[];
  /** 该桶匹配的总行数（不受 items 的 30 条截断影响）。缺省按 items.length 处理
   *  （调用方拿不到 total 时不谎报「还有 N 条」）。 */
  total?: number;
  /** 行是否可点（缺省全可点）。用于「部分行因权限点不动」的场景：组件只呈现
   *  不可点（去 pointer 光标 / 不吃 hover / 不 emit），不判「为什么」不可点。 */
  rowClickable?: (item: SystemDeliveryOrderData) => boolean;
}>();

const emit = defineEmits<(e: 'rowClick', part: SystemDeliveryOrderData) => void>();

/** 该行是否可点。未传谓词 → 全可点（保持单测与既有调用方的零配置行为）。 */
function isRowClickable(item: SystemDeliveryOrderData): boolean {
  return props.rowClickable ? props.rowClickable(item) : true;
}

function onRowClick(item: SystemDeliveryOrderData): void {
  if (!isRowClickable(item)) return;
  emit('rowClick', item);
}

const isPartialVariant = computed(() => props.variant === 'partial');

const titleIcon = computed(() => {
  if (isPartialVariant.value) return GoodsFilled;
  return props.variant === 'overdue' ? WarningFilled : Bell;
});

const TITLE_TEXT = {
  // 「含今天」是硬约束：服务端 upcoming 桶判据是 system_delivery_date >= today，
  // 写「今天之后」会把今天到期（该桶最常见的一档）排除在标题之外。
  upcoming: '今天及以后到期',
  overdue: '已逾期未交',
  partial: '部分已交工单',
} as const;

/** 副标题要点破真实判据：「没交过」是服务端按有无已交批次判的，与加急无关；
 *  partial 不限时间窗口。 */
const SUBTITLE_TEXT = {
  upcoming: '一件都没交过 · 按系统交期升序',
  overdue: '一件都没交过 · 按系统交期升序',
  partial: '已交过一部分 · 不限时间',
} as const;

const EMPTY_TEXT = {
  upcoming: '暂无今天及以后到期的未交工单',
  overdue: '暂无已逾期未交货单',
  partial: '暂无部分已交工单',
} as const;

const titleText = computed(() => TITLE_TEXT[props.variant]);
const subtitleText = computed(() => SUBTITLE_TEXT[props.variant]);
const emptyText = computed(() => EMPTY_TEXT[props.variant]);

/** 截断提示：total 是服务端匹配总行数，items 最多 30 行。两者不等时告诉用户
 *  「被砍了多少」—— upcoming 桶没有时间上界，这是常态而非异常。 */
const truncatedHint = computed(() => {
  const total = props.total ?? props.items.length;
  if (total <= props.items.length) return '';
  return `共 ${total} 条，另有 ${total - props.items.length} 条未显示`;
});

/** partial 数量列的 tooltip：显式标注单位与含义。**单位随 row_type 变** ——
 *  件级行（PART）说「件」，装配件行（ASSEMBLY）说「套」（装配件的部分已交按套计）。 */
function deliveredTooltip(item: SystemDeliveryOrderData): string {
  const unit = item.row_type === 'ASSEMBLY' ? '套' : '件';
  return `已送 ${item.delivered_quantity} ${unit} / 总量 ${item.quantity} ${unit}`;
}
</script>

<style lang="scss" scoped>
.list-card {
  background: #fff;
  border-radius: 6px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  // 依赖父 .main-right 的 flex chain 均分高度（flex: 1 1 0 + min-height 兜底），
  // 不写 height: calc(100vh - ...) 以免高度在多分辨率下退化。
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  // 160 而非更高的兜底：右栏两卡均分 + 16px gap ⇒ 内容硬地板 = 160×2 + 16 = 336px。
  // 再加 .dashboard 自身的 92px（上下 padding 32 + 行间 gap 16 + KPI 行预留 44；
  // KPI 行实际更高时阈值按比例上移）⇒ 视口高 ≲ 428px 时地板就超出可视区。
  // **双列下没有滚动路径**：.dashboard 是定高 + overflow: hidden，.el-main 拿到的
  // 是定高子元素、永不滚动，超出部分直接被裁掉。.el-main 的纵向滚动兜底只在
  // ≤1100px 的单列分支（.dashboard 改 height: auto）成立。
  min-height: 160px;
  :deep(.el-card__header) {
    padding: 10px 14px;
    background: #fafbfc;
    border-bottom: 1px solid #eee;
    // 头不被两卡均分的 flex 压扁（否则标题行会逐卡矮一截）。
    flex-shrink: 0;
  }
  :deep(.el-card__body) {
    padding: 0;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
}
.list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}
// 第二行：截断提示（左侧）+ 父组件注入的控件（右侧，如 upcoming / overdue 的 radio）。
// 与 .list-header 分离成两行而不是挤进同一行：右栏容器最窄档实测 340px，
// 标题 + 副标题 + radio 三者同排必然互相挤压到 ellipsis。
//
// 换行兜底：即便拆成两行，最窄档（容器 340px 扣 header padding 后可用 312px）仍装不下
// 「截断提示 + 两个 size=small radio」同排（合计约 320px+）。upcoming 桶无时间上界 ⇒
// 截断提示是常态而非边缘情况，故必须能换行；提示文字本身走单行 ellipsis（换行会把
// header 撑高、把下面的行挤少），控件槽不许收缩（radio 按钮 nowrap，压缩即裁字）。
.list-header-extra {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 6px 8px;
  margin-top: 6px;
}
.list-truncated {
  font-size: 11px;
  color: var(--text-secondary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.list-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
}
.list-subtitle {
  font-size: 12px;
  color: var(--text-secondary);
}
.list-empty {
  padding: 40px 0;
  display: flex;
  justify-content: center;
}
.list-rows {
  display: flex;
  flex-direction: column;
  // 2026-10-03：行宽分档以「卡片正文宽」为口径，故用容器查询而不是视口媒体查询 ——
  // 同一视口下正文宽还会随左侧栏展开/收起与 1100px 单列折叠变化。
  // 三档与视口的实测对应（侧栏展开 165px、无滚动条占位）：容器 ≤440px ← 视口
  // 1101~1350、441~560px ← 视口 1351~1650、>560px ← 视口 ≥1651；视口 ≤1100 折叠成单列
  // （容器 869px）直接吃满档。经典滚动条平台（.el-card__body overflow-y:auto，30 行时
  // 出滚动条）容器再窄 ~15px，侧栏折叠同理 ⇒ 这几个边界只是路标，档位以容器宽为准。
  container-type: inline-size;
  container-name: sysdeliveryrow;
}
.row {
  display: grid;
  // 2026-10-03：6 列 = 序列号 | 名称 | 数量 | 二级客户 | 状态 | 系统交期。
  // 定宽依据取真实数据：serial_no 恒 5 字符（12px 等宽 = 36px）、二级客户 ≤5 字符、
  // 交期恒 MM/DD（36px）；名称 p90 20 字符，容器 > 560px 时给满 200px。状态列按
  // el-tag--small 最坏宽度定轨（ORDER_STATUS_LABEL 恒 3 个汉字 ≈ 52px）。二级客户吃
  // 剩余空间，窄屏截断由 ellipsis + tooltip 兜。
  //
  // 数量列 80px 的由来（partial 档「已交 / 总量」是最不可截的信息）：三档统一 80px
  // —— 非 partial 变体出纯数字用不满，但三个变体必须同轨，否则同一容器下切变体整行
  // 错位。12px 等宽最坏平台 7.2px/字符（SF Mono 0.6em；Consolas 0.55em 更窄），
  // 「1791 / 1791」= 9 字符 + 分隔符两侧各 2px = 68.8px，留 11px 余量（8 字符的
  // 「1791 / 100」= 61.6px 更宽裕）。数量实测可达 4 位（本仓 fixture 即
  // quantity: 1791），要两侧都 5 位（总字符 ≥ 11、≈ 83px）才触 ellipsis —— 故
  // .row-qty--partial 刻意不用 flex，ellipsis 生效时至少是可见截断而非静默切断。
  grid-template-columns: 56px 200px 80px minmax(0, 1fr) 56px 56px;
  gap: 6px;
  align-items: center;
  padding: 8px 10px;
  font-size: 13px;
  border-bottom: 1px dashed #f0f0f0;
  cursor: pointer;
  transition: background-color 0.12s;
  &:hover {
    background: #f5f7fa;
  }
  &.urgent {
    background: #fde2e2;
    &:hover {
      background: #fbd7d7;
    }
  }
  // 不可点的行：去 pointer 光标 + 不吃 hover 高亮 + 不 emit（见 rowClickable prop）。
  // 加急红底**保留** —— 它表达的是「加急」语义，与能否点开无关；上面两条规则按源码
  // 顺序排在 .urgent 之后，故需要同等特异性把它们压回红底。
  &.row--locked {
    cursor: default;
    &:hover {
      background: #fff;
    }
    &.urgent,
    &.urgent:hover {
      background: #fde2e2;
    }
  }
  &:last-child {
    border-bottom: none;
  }
}
.row-serial,
.row-qty,
.row-due {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 12px;
}
.row-serial {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.row-qty {
  color: var(--text-primary);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-qty--partial {
  // 刻意**不用** display:flex —— text-overflow: ellipsis 对 flex 容器不生效，溢出
  // 会变成从字符中间静默切断（连省略号都没有），而这一列正是 partial 变体的全部信息。
  // 保持普通 span（.row-qty 的 overflow/ellipsis 直接生效），分隔符间距改用 sep 的
  // margin 表达 —— 视觉与原先 flex + gap: 2px 等价（都是分隔符两侧各 2px）。
  .row-qty-sep {
    margin: 0 2px;
  }
}
.row-qty-done {
  color: var(--primary-color);
  font-weight: 600;
}
.row-qty-sep {
  color: var(--text-secondary);
}
.row-customer {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--primary-color);
  font-size: 12px;
}
.row-due {
  color: var(--text-secondary);
  text-align: right;
  // 2026-10-10：逾期分支不再是死规则 —— overdue 桶的行 system_delivery_date <
  // today，deliveryUrgencyClass 恒返 'overdue'。不写这条规则时逾期交期会静默退成
  // 普通灰，而这正是本桶唯一的强调点。partial 桶无时间窗口、upcoming 桶恒 >= today，
  // 两者的逾期类只可能来自数据本身（system_delivery_date 为 null 时不命中）。
  &.due-soon {
    color: var(--el-color-warning);
    font-weight: 600;
  }
  &.overdue {
    color: var(--el-color-danger);
    font-weight: 600;
  }
}
@container sysdeliveryrow (max-width: 560px) {
  .row {
    // 名称列 120px：数量列从 56 加宽到 80 后，本档下缘（容器 441px）留给二级客户的
    // 余量只剩 5px（不足半个汉字）。名称让到 120px（≈9 个汉字，仍短于 p90 20 字符，
    // 靠 tooltip 兜），把二级客户抬回 35px。状态列 56px = el-tag--small 最坏宽度
    // 52px + 4px 余量。
    grid-template-columns: 48px 120px 80px minmax(0, 1fr) 56px 52px;
  }
}
@container sysdeliveryrow (max-width: 440px) {
  .row {
    // 极窄档（本档容器对应视口 1101~1350、实测 340~440px；再窄就折叠成单列、
    // 容器 869px 直接吃满档）。名称列取 clamp(48px, 16cqi, 88px)：本档
    // 的宽度预算要同时喂饱 80px 的数量列和 1fr 的二级客户列，名称是三列里唯一
    // 「让位代价最低」的 —— 它截断后有 tooltip，且同一信息在行点击后的
    // PartPreviewDialog 里完整可读。
    //   1fr（二级客户）实测：容器 340（视口 1101）→ 19.9；容器 412（视口 1280）
    //   → 80.1；容器 440（视口 1350）→ 103.6（对应名称列 54.5 / 65.9 / 70.4）。
    //   clamp 上下限本档都取不到，是越界保护。
    // 序列号 40px（5 字符需 36px）/ 交期 44px（MM/DD 需 36px）—— 两列都只比内容
    // 宽几像素，是本档仅剩的余量来源。状态列 52px = el-tag--small 最坏宽度，零余量
    // 但不裁字。
    grid-template-columns: 40px clamp(48px, 16cqi, 88px) 80px minmax(0, 1fr) 52px 44px;
  }
}
</style>
