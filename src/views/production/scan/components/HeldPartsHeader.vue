<!--
  HeldPartsHeader.vue

  持有件面板的**头部**（工人标识 + 「已加载 N 件（共 M 件）」计数 + 刷新按钮），
  与 `HeldPartsList.vue` 同为 `HeldPartsBadge` 抽屉的展示件。
  （同日 `/scan/action` 的「查看持有」由 `HeldPartsDialog` 改为独立页
  `ScanHeldParts.vue`，它有自己的 `.parts-header` + 计数 tag，不消费本组件。）

  为什么头部当初也要抽而不是各写一份：「已加载 N 件」与信封 `total` 不等即表示列表被
  后端 limit 截断（不再谎称是全部）—— 这个口径、以及「N 取已加载件数、不是 total」
  的取法只要有两份就会漂移，徽章上写着 3 件、弹窗里写着 5 件这类不一致很难在排障时
  联想到是两处各算的。同理，刷新按钮的入口位置与 loading 态也是同一个口径。

  纯展示组件：**不碰 query、不发请求**。数据（`count` / `total` / `loading`）由调用方
  从 `useScanHeldQuery` 算好传进来，点击「刷新」只向上抛 `refresh` 事件，由调用方决定
  是 refetch 还是别的 —— 与 `HeldPartsList` 的边界划分一致。
-->

<template>
  <div class="held-header">
    <span class="held-subtitle">
      <el-icon><User /></el-icon>
      <span>{{ workerId ? '当前工人' : '未识别' }}</span>
      <span class="held-count-inline"
        >已加载 {{ count }} 件<template v-if="total > count">（共 {{ total }} 件）</template></span
      >
    </span>
    <el-button size="small" link :loading="loading" @click="emit('refresh')">
      <el-icon><Refresh /></el-icon>
      <span>刷新</span>
    </el-button>
  </div>
</template>

<script setup lang="ts">
import { Refresh, User } from '@element-plus/icons-vue';

withDefaults(
  defineProps<{
    /** 工人雪花 ID 字符串；空 / null 时标题显示「未识别」（尚未扫到工牌）。 */
    workerId?: string | null;
    /** 已加载件数（`data.items.length`）。 */
    count: number;
    /** 信封里的总条数；`total > count` 时补「（共 M 件）」说明列表被 limit 截断。 */
    total: number;
    /** 拉取中（`query.isFetching`），透传给刷新按钮的 loading 态。 */
    loading?: boolean;
  }>(),
  { workerId: null, loading: false },
);

const emit = defineEmits<{ refresh: [] }>();
</script>

<style scoped>
.held-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.held-subtitle {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #606266;
  font-size: 13px;
}
.held-count-inline {
  margin-left: 6px;
  padding: 2px 8px;
  background: #ecf5ff;
  color: #409eff;
  border-radius: 10px;
  font-weight: 600;
}
</style>
