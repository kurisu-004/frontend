<!--
  ScanHeldParts.vue

  `/scan/held` —— 扫码台「查看持有」**独立页**（2026-10-11）。原先是操作选择页上的一个
  对话框（`HeldPartsDialog`），形态上与取件 / 放回 / 送检不一致：那几个动作都进独立页，
  「我手上有什么」却是一层盖住整屏的弹窗，工人关掉还得记住自己刚才点过哪个按钮。
  本页与三页**同款顶栏、同款卡片、同款三列网格、同款滚动箭头**。

  只读页：无选中态、无写操作、不弹扫码确认。这里**不加** 2026-10-11 后端新增的
  部分数量流转（那是放回 / 送检页的能力），也不做任何本地增删假定 ——
  列表的刷新全部走 TanStack Query 的失效链（写操作在别的页发生）。

  数据源 `useScanHeldQuery`，params 与徽章 / 放回页 / 送检页**逐字一致**
  （`{ workerId, limit: 200 }`）⇒ 落在同一条 `qk.scanHeld` 上，同屏去重成 1 次请求；
  写成另一个形状会让 query key 分裂、同屏发两次完全相同的请求。

  ⚠️ 路由 path `scan/held` 是浏览器可见的书签 URL，与其余 5 条子路由一样共用
  `menuCode: 'scan_badge'`，菜单表与 `composables/__fixtures__/adminMenus.ts` 零改动。
-->

<template>
  <div class="scan-held">
    <ScanTopbar :worker="worker" flow-label="查 看" flow-tag-type="info">
      <template #actions>
        <el-button type="info" plain @click="backToAction">
          <el-icon><Back /></el-icon>
          <span>返回操作选择</span>
        </el-button>
        <el-button type="warning" plain @click="backToBadge">
          <el-icon><Refresh /></el-icon>
          <span>重新扫工牌</span>
        </el-button>
      </template>
    </ScanTopbar>

    <div ref="contentRef" class="content">
      <div v-if="loadingList" class="loading-block">
        <el-icon :size="32" class="is-loading"><Loading /></el-icon>
        <p>加载持有零件列表…</p>
      </div>

      <div v-else-if="!worker?.id" class="empty-block">
        <el-icon :size="60" color="#e6a23c"><Warning /></el-icon>
        <h3>未识别工人</h3>
        <p>请重新刷工牌。</p>
        <el-button type="primary" @click="backToAction">返回</el-button>
      </div>

      <div v-else-if="errorMsg" class="empty-block">
        <el-icon :size="60" color="#f56c6c"><Warning /></el-icon>
        <h3>加载失败</h3>
        <p>{{ errorMsg }}</p>
        <el-button type="primary" @click="refresh">重试</el-button>
      </div>

      <div v-else-if="parts.length === 0" class="empty-block">
        <el-icon :size="60" color="#c0c4cc"><Box /></el-icon>
        <h3>您当前没有持有零件</h3>
        <p>请先到「取件」领取零件后再回来看。</p>
        <el-button type="primary" @click="refresh">刷新</el-button>
        <el-button @click="backToAction">返回</el-button>
      </div>

      <div v-else>
        <div class="parts-header">
          <el-icon :size="24"><Box /></el-icon>
          <span class="parts-header-text">我的持有零件</span>
          <el-tag type="info" effect="plain" size="large" class="count-tag">
            共 {{ total }} 件<template v-if="total > parts.length"
              >（显示前 {{ parts.length }} 件）</template
            >
          </el-tag>
          <el-button :icon="Refresh" circle size="small" @click="refresh" />
        </div>

        <div class="parts-list">
          <PartRowCard
            v-for="p in sortedParts"
            :key="p.batch_id || p.id"
            :row="p"
            :previewing="previewDlg?.loading === true && previewPart?.id === p.id"
            @preview="openPreview"
          />
        </div>
      </div>
    </div>

    <ScrollFabPair :target="contentRef" />

    <PartDrawingPreviewDialog
      ref="previewDlg"
      v-model="showPreview"
      :part="previewPart"
      :title="previewTitle"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeMount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Back, Box, Loading, Refresh, Warning } from '@element-plus/icons-vue';
import { useScanSession } from '@/views/production/scan/composables/useScanSession';
import { useScanPartsSort } from '@/views/production/scan/composables/useScanPartsSort';
import { useScanHeldQuery } from '@/views/production/scan/composables/useScanListQuery';
import { scanListErrorText } from '@/views/production/scan/composables/scanListErrorMessage';
import PartRowCard from '@/views/production/scan/components/PartRowCard.vue';
import PartDrawingPreviewDialog from '@/views/production/scan/components/PartDrawingPreviewDialog.vue';
import ScanTopbar from '@/views/production/scan/components/ScanTopbar.vue';
import ScrollFabPair from '@/views/production/scan/components/ScrollFabPair.vue';
import type { ScanPartRowSchema } from '@/views/production/scan/composables/scanSchema';

const router = useRouter();
const { worker, requireWorker, reset: resetScanSession } = useScanSession();

// `silent: true`：本页的顶栏没有徽章，但放回页 / 送检页挂在同一条 query key 上，
// 让它们弹 toast 本页渲染一行错误即可（两处各弹一次会在同一次失败上弹两条一样的
// toast）。口径与 `HeldPartsBadge` 一致。
const held = useScanHeldQuery(
  () => (worker.value?.id ? { workerId: String(worker.value.id), limit: 200 } : null),
  { silent: true },
);

const parts = computed<ScanPartRowSchema[]>(() => held.query.data.value?.items ?? []);
const total = computed(() => held.query.data.value?.total ?? 0);
// `isPending`（还没有任何数据）而非 `isFetching`：写后在途的 refetch 不该让整页闪一次
// loading 块（三页同一口径）。
const loadingList = computed(() => held.query.isPending.value);
const errorMsg = computed(() => {
  const e = held.query.error.value;
  return e ? scanListErrorText(e, '加载失败') : null;
});
// 「系统交期」硬优先级 + 原 is_urgent / planned_delivery_date 排序；详见 composable 注释
const sortedParts = useScanPartsSort(parts);

const contentRef = ref<HTMLElement | null>(null);

/** 页面「刷新」按钮：走 query 的 refetch。 */
function refresh(): Promise<void> {
  return held.fetchList();
}

// --- 预览（与三页同款：卡片上的预览按钮 → 同一个图纸预览弹窗） ---
const showPreview = ref(false);
const previewPart = ref<ScanPartRowSchema | null>(null);
/** 「正在预览哪一行」由弹窗自己管（它才发那两次请求），本页只经这个 ref 读它的 loading。 */
const previewDlg = ref<InstanceType<typeof PartDrawingPreviewDialog> | null>(null);

/** 弹窗弹出的那一刻 loading 归弹窗管，本页只在 `previewPart` 里记下是哪一行。 */
function openPreview(p: ScanPartRowSchema): void {
  previewPart.value = p;
  showPreview.value = true;
}

const previewTitle = computed<string>(
  () => `预览 — ${previewPart.value?.serial_no || previewPart.value?.drawing_no || ''}`,
);

onBeforeMount(() => {
  requireWorker(router);
});

function backToAction(): void {
  void router.replace('/scan/action');
}

function backToBadge(): void {
  resetScanSession();
  void router.replace('/scan/badge');
}
</script>

<style lang="scss" scoped>
.scan-held {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: #f5f7fa;
}

/* `.topbar` / `.part-row*` / 预览弹窗四分支的样式都在 components/ 的三个共用件里
   （ScanTopbar / PartRowCard / PartDrawingPreviewDialog），本页只留自己这一份的骨架。 */

/* 与三页同款容器：max-width 1560px + 左右 120px padding（避开 ScrollFabPair 占的
   屏右 24~92px），推导见 ScanPickParts.vue 同名规则的注释。 */
.content {
  flex: 1;
  overflow: auto;
  max-width: 1560px;
  width: 100%;
  margin: 0 auto;
  padding: 24px 120px;
}

.loading-block,
.empty-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 0;
  gap: 12px;
  color: #606266;
  text-align: center;
  h3 {
    font-size: 20px;
    margin: 0;
    color: #303133;
  }
  p {
    color: #909399;
    max-width: 480px;
  }
}

.parts-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  color: #303133;
}
.parts-header-text {
  font-size: 20px;
  font-weight: 600;
}
.count-tag {
  font-size: 16px;
  padding: 6px 14px;
}

/* 三列网格（与三页同款），零 @media / 零断点：报工台是 HMI 固定横屏。 */
.parts-list {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.is-loading {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
