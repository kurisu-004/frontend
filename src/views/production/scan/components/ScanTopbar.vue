<!--
  ScanTopbar.vue

  报工台**列表类页面**的顶栏（2026-10-11 从 ScanPickParts / ScanReturnParts /
  ScanInspectParts 三页抽出）：左侧固定是「图标 + 报工台 + 工人名 + 工牌 tag +
  流程 tag」，右侧由调用方用 `actions` 插槽塞（徽章 / 返回 / 重扫）。

  `ScanActionPicker` / `ScanBadgeGate` **不消费本组件**：那两页的顶栏没有 divider 后的
  流程 tag，右侧按钮也不同，是两套形态，硬并进来只会多出一层空洞的插槽。

  流程 tag 默认按 `flowLabel` + `flowTagType` 渲染；需要非默认形态（例如再挂一个图标）
  时用 `flow` 插槽整体接管。

  纯展示：**不碰 query / session**，工人身份由调用方从 `useScanSession` 传进来。
  只接 `ScanWorkerBriefDto`（后端 `ScanWorkerBrief` 的 4 字段窄投影），不是账号管理页
  那个 12 字段的 `WorkerOut` —— 扫码链路一个额外字段都不用。
-->

<template>
  <div class="topbar">
    <div class="topbar-left">
      <el-icon :size="22" color="#fff"><Avatar /></el-icon>
      <span class="title">报工台</span>
      <el-divider direction="vertical" class="divider" />
      <span class="worker-name">{{ worker?.name ?? '—' }}</span>
      <el-tag size="default" type="info" effect="dark" class="badge-tag">
        {{ worker?.badge_code ?? '' }}
      </el-tag>
      <el-divider direction="vertical" class="divider" />
      <slot name="flow">
        <el-tag :type="flowTagType" effect="dark">{{ flowLabel }}</el-tag>
      </slot>
    </div>
    <div class="topbar-right">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { Avatar } from '@element-plus/icons-vue';
import type { ScanWorkerBriefDto } from '@/api/productionScan.contract';

withDefaults(
  defineProps<{
    /** 扫到的工人（`useScanSession().worker`）；null 时姓名位显示 '—'、工牌 tag 为空。 */
    worker: ScanWorkerBriefDto | null;
    /** 流程 tag 文案（「取 件」/「放 回」/「送 检」/…）。 */
    flowLabel: string;
    /** 流程 tag 的 Element Plus 语义色。 */
    flowTagType?: 'primary' | 'success' | 'warning' | 'info' | 'danger';
  }>(),
  { flowTagType: 'primary' },
);
</script>

<style lang="scss" scoped>
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: linear-gradient(90deg, #142d54 0%, var(--primary-color) 100%);
  color: #fff;
  padding: 12px 24px;
  height: 60px;
  flex-shrink: 0;
}
.topbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 16px;
}
.topbar-right {
  display: flex;
  gap: 8px;
}
.title {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 2px;
}
.divider {
  background: rgba(255, 255, 255, 0.3);
  height: 20px;
}
.worker-name {
  font-size: 18px;
  font-weight: 600;
}
.badge-tag {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
}
</style>
