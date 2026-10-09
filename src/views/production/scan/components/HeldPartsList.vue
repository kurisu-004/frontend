<!--
  HeldPartsList.vue

  持有件列表的**唯一渲染实现**（2026-10-11 从 `HeldPartsBadge.vue` 抽出，域内两处共用）：
    - `HeldPartsBadge`：顶栏徽章点开后的抽屉；
    - `HeldPartsDialog`：扫码台 `/scan/action` 的「查看持有」弹窗。

  抽出的原因不是「徽章太长」而是**要复用**：两处读的是同一条 `qk.scanHeld`、同一份
  `ScanPartRowSchema`，展示口径必须逐字一致；复制一份就等于把「加急怎么标 / 工序怎么显示」
  这类口径变成两份，迟早漂移。

  纯展示组件：**不碰 query、不碰 api、不发请求**，数据与错误文案都由调用方算好传进来
  （调用方用 `useScanHeldQuery` + `silent: true`，错误渲染进本组件的 `errorMsg` 行而不是
  弹 toast —— 同一条 query key 上若两个消费方都弹，一次失败会弹两条一模一样的 toast）。

  ⚠️ 四种状态（加载 / 错误 / 空 / 列表）都在本组件内：调用方若各自渲染一遍就要复制三段
  标记与样式，抽组件就白抽了。根节点用 `display: contents` —— 它不生成盒子、四个状态因此
  直接成为调用方容器的 flex item（gap 也照旧生效），徽章抽出前后的排布**逐像素一致**。
  换成普通块级根就会多出一层盒子把 `.held-card` 的 `gap: 12px` 断掉。

  字段全部取自 `ScanPartRowSchema` 已有的 17 个键，**不新增任何后端字段**：held 的 VO 没有
  批次号也没有客户名；工序四件套（`chain_*`）在没有工序链时恒为 null，所以「工序」按
  **有值才显示**判定，不显示假占位。
-->

<template>
  <div class="held-list-root">
    <div v-if="loading && items.length === 0" class="held-loading">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>加载中…</span>
    </div>

    <div v-else-if="errorMsg" class="held-error">
      <el-icon color="#f56c6c"><WarningFilled /></el-icon>
      <span>{{ errorMsg }}</span>
    </div>

    <div v-else-if="items.length === 0" class="held-empty">
      <el-icon :size="48" color="#c0c4cc"><Box /></el-icon>
      <p>暂未持有零件</p>
      <p class="held-empty-hint">{{ emptyHint }}</p>
    </div>

    <div v-else class="held-list" :style="{ maxHeight: maxListHeight }">
      <!-- 2026-10-04：key 用 `p.batch_id || p.id`（与报工台三页列表同口径）。
           后端把 held 端点的 `batch_id` 填上后，同一 part 的多个批次会在
           列表里撞 part id ⇒ Vue duplicate-key（整列表只渲染一行且控制台告警）。
           批次锚点缺失（老数据 / 后端回退）时退回 part id。 -->
      <div
        v-for="p in items"
        :key="p.batch_id || p.id"
        :class="['held-row', { 'is-urgent': p.is_urgent }]"
      >
        <div class="held-row-main">
          <span class="held-serial">{{ p.serial_no || '—' }}</span>
          <span class="held-drawing">{{ p.drawing_no }}</span>
          <span class="held-qty">{{ p.quantity }} 件</span>
        </div>
        <div class="held-row-name">{{ p.name }}</div>
        <!-- 2026-10-11 扩展示：加急 / 交期 / 工序三块各自「有值才渲染」。
             `planned_delivery_date` 后端给的是**真实值**（不再是 `1970-01-01` 占位符），
             仍留一层零值守卫：脏数据下渲染出一个空白 pill 比什么都不显示更难读。
             工序取「当前工序名 || 下一道工序名」—— 刚领取时只有 current，
             放回前那一道则只有 next。 -->
        <div v-if="p.is_urgent || dueTextOf(p) || processTextOf(p)" class="held-row-sub">
          <span v-if="p.is_urgent" class="urgent-tag">加急</span>
          <span v-if="dueTextOf(p)" class="meta-tag">交期 {{ dueTextOf(p) }}</span>
          <span v-if="processTextOf(p)" class="meta-tag">工序 {{ processTextOf(p) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Box, Loading, WarningFilled } from '@element-plus/icons-vue';
// 用域内 schema 的 z.infer（`ScanPartRowSchema`）而不是 api 层的 `ScanPartRowSchema`：
// 本组件吃的是 queryFn 守门**之后**的数据，两者在 chain 四件套上有意不同（schema 给
// `chain_state` 留了 nullish，DTO 声明成非空 string）。三页列表用的是同一个类型。
import type { ScanPartRowSchema } from '@/views/production/scan/composables/scanSchema';

withDefaults(
  defineProps<{
    /** `useScanHeldQuery` 的 `data.items`（Zod 守门后的 `ScanPartRowSchema[]`）。 */
    items: ScanPartRowSchema[];
    /** 拉取中（`query.isFetching`）；已有数据时不再盖空态，避免刷新时列表闪一下。 */
    loading?: boolean;
    /** 错误文案（调用方算好传进来，本组件不弹 toast）。 */
    errorMsg?: string | null;
    /** 列表区最大高度（抽屉给 `calc(100vh - 200px)`，弹窗给 `52vh`）。 */
    maxListHeight?: string;
    /** 空态的引导文案，两个调用方各给一句。 */
    emptyHint?: string;
  }>(),
  {
    loading: false,
    errorMsg: null,
    maxListHeight: 'calc(100vh - 200px)',
    emptyHint: '领取后会出现在这里',
  },
);

/**
 * 交期文本；空串与全零日期（后端老数据 / 序列化占位）都按「没有值」处理。
 *
 * 判「有值」而不是判某个枚举 / 阈值：交期与工序在本 VO 里都是**可为空的字符串**，
 * 任何形态判断都会在某天新增一种形态时静默漏显。
 */
function dueTextOf(p: ScanPartRowSchema): string | null {
  const v = (p.planned_delivery_date ?? '').trim();
  if (!v || /^0{4}-0{2}-0{2}$/.test(v)) return null;
  return v;
}

/** 工序名：当前工序优先，没有则取下一道；两者皆 null = 没有工序链，整块不渲染。 */
function processTextOf(p: ScanPartRowSchema): string | null {
  return p.chain_current_process_name || p.chain_next_process_name || null;
}
</script>

<style scoped>
.held-list-root {
  display: contents;
}
.held-loading,
.held-error,
.held-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 32px 8px;
  color: #909399;
  font-size: 13px;
  text-align: center;
}
.held-error {
  color: #f56c6c;
}
.held-empty-hint {
  font-size: 12px;
  color: #c0c4cc;
  margin: 0;
}
.held-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  padding-right: 4px;
}
.held-row {
  border: 1px solid #ebeef5;
  border-radius: 6px;
  padding: 10px 12px;
  background: #fafafa;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.held-row.is-urgent {
  background: #fdf6ec;
  border-color: #f9d77e;
}
.held-row-main {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.held-serial {
  font-weight: 600;
  color: #303133;
  min-width: 72px;
}
.held-drawing {
  color: #606266;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 数量右对齐贴边：它是这一行里唯一长度不定（1 / 12 / 120）的数字，挤在图号后面会
   把图号的省略号触发得毫无规律。 */
.held-qty {
  margin-left: auto;
  color: #409eff;
  font-weight: 600;
  flex-shrink: 0;
}
.held-row-name {
  font-size: 13px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.held-row-sub {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
}
.urgent-tag {
  color: #e6a23c;
  font-weight: 600;
  font-size: 12px;
}
.meta-tag {
  color: #909399;
  font-size: 12px;
  padding: 1px 6px;
  background: #f4f4f5;
  border-radius: 8px;
}
</style>
