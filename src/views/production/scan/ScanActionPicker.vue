<!--
  ScanActionPicker.vue

  /scan/action：选择报工操作（取件 / 放回 / 送检）。
  入口守卫：worker 缺失则跳回 /scan/badge。

  按钮按「绑定架 zone 并集」显示（HMI 账号在账号管理页绑定的货架决定）：
    * 绑了任意 PRODUCTION 架 → PICK_UP + RETURN
    * 绑了任意 INSPECTION 架 → INSPECT
    * 两种 zone 都绑了 → 三个按钮全显示

  2026-10-10 硬切后：RETURN / INSPECT 走 worker-scan（`POST /prod/scan/worker-scan`，
  event_type=RETURNED / INSPECTED）二合一；PICK_UP 走
  `POST /prod/scan/batches/{batch_id}/pick-up`（批次锚定领取）。
  送货入口在送货单列表页的「送货」按钮，扫码台不再有
  DELIVER 操作（`useScanSession` 的 DELIVER 枚举成员已于 2026-10-08 随之删除）。

  2026-10-10：**「当前作业货架」整条下线**（顶部横条 + `WorkingShelfDialog` + 点送检
  时的选架中转）。目标货架改由后端按负载自动选择，工人不再指定货架，作业架这个概念
  也就没有存在意义了。按钮显隐仍由「绑定架 zone 并集」决定，判据从
  `useScanShelfStore` 换成了共享 `useProductionShelvesQuery` × `auth.boundShelves`
  —— store 已随作业架一起删除，而显隐规则是现场账号权限的一部分，不能跟着一起没。

  2026-10-11 新增第四个入口「查看持有」：工人在这一页还没领件时看不到任何持有信息
  （徽章挂在报工台布局里，本页自己画顶栏），而工人在动手之前就该知道手上有什么。
  它**不是报工动作**（不进 `useScanSession`、不跳页、不写任何状态），只是一个只读入口：
    · 显隐只看「扫到工人」（`worker.id`），与三个动作按钮的 zone 判定完全无关 ——
      没绑架的账号也能看自己持有什么；
    · 角标与弹窗都读同一条 `qk.scanHeld`（params 与徽章 / 放回页 / 送检页逐字一致
      ⇒ 同屏去重），本页不新增任何请求；
    · 三个动作按钮的显隐逻辑与 `noActionReason` 口径**一字未动**。
  网格因此从 3 列改为 2×2（理由见 `.action-grid` 的注释）。
-->

<template>
  <div class="action-picker">
    <div class="topbar">
      <div class="topbar-left">
        <el-icon :size="22" color="#fff"><Avatar /></el-icon>
        <span class="title">报工台</span>
        <el-divider direction="vertical" class="divider" />
        <span class="worker-name">{{ worker?.name ?? '—' }}</span>
        <el-tag size="default" type="info" effect="dark" class="badge-tag">
          {{ worker?.badge_code ?? '' }}
        </el-tag>
      </div>
      <div class="topbar-right">
        <el-button type="warning" plain @click="rescanBadge">
          <el-icon><Refresh /></el-icon>
          <span>重新扫工牌</span>
        </el-button>
      </div>
    </div>

    <div class="content">
      <h2 class="state-title">请选择报工操作</h2>
      <div v-if="shelfLoading" style="text-align: center; padding: 40px 0; color: #909399">
        加载货架信息...
      </div>
      <div v-else-if="noActionReason" style="text-align: center; padding: 40px 0; color: #909399">
        {{ noActionReason }}
      </div>
      <div v-else :class="['action-grid', { 'action-grid--row': !showInspect }]">
        <el-button
          v-if="showPickUp"
          type="primary"
          size="large"
          class="action-btn"
          @click="selectAction('PICK_UP')"
        >
          <el-icon :size="48"><Box /></el-icon>
          <span class="action-label">取 件</span>
          <span class="action-desc">扫码领取，开始加工</span>
        </el-button>
        <el-button
          v-if="showReturn"
          type="warning"
          size="large"
          class="action-btn"
          @click="selectAction('RETURN')"
        >
          <el-icon :size="48"><Back /></el-icon>
          <span class="action-label">放 回</span>
          <span class="action-desc">加工完一道工序放回待加工区</span>
        </el-button>
        <el-button
          v-if="showInspect"
          type="success"
          size="large"
          class="action-btn"
          @click="selectAction('INSPECT')"
        >
          <el-icon :size="48"><Check /></el-icon>
          <span class="action-label">送 检</span>
          <span class="action-desc">全部工序完成，送到品检区</span>
        </el-button>
        <!-- 2026-10-11 新增：第四个入口「查看持有」。它**不是**报工动作，只是让工人在
             这一页就能看到手上有什么（角标是已加载件数）—— 徽章挂在报工台布局里，
             本页自己画顶栏，拿不到。显隐只看「扫到工人」，与三个动作按钮的货架 zone 判定
             **完全无关**：没绑架的账号也能看自己持有什么，那是只读信息。 -->
        <el-button
          v-if="showHeld"
          type="info"
          size="large"
          class="action-btn"
          data-testid="held-btn"
          @click="heldDialogOpen = true"
        >
          <el-icon :size="48"><Box /></el-icon>
          <span class="action-label">查 看</span>
          <span class="action-desc">
            查看当前持有的零件<template v-if="heldCount > 0">（{{ heldCount }} 件）</template>
          </span>
        </el-button>
      </div>
    </div>

    <HeldPartsDialog v-model="heldDialogOpen" :worker-id="worker ? String(worker.id) : null" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeMount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Avatar, Back, Box, Check, Refresh } from '@element-plus/icons-vue';
import {
  ACTION_LABEL,
  useScanSession,
  type WorkAction,
} from '@/views/production/scan/composables/useScanSession';
import { useProductionShelvesQuery } from '@/composables/queries/useProductionShelvesQuery';
import { useScanHeldQuery } from '@/views/production/scan/composables/useScanListQuery';
import HeldPartsDialog from '@/views/production/scan/components/HeldPartsDialog.vue';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();
const { worker, setAction, reset, requireWorker } = useScanSession();

// 2026-10-10：按钮显隐改由**账号货架绑定的 zone 并集**决定（经共享
// useProductionShelvesQuery 解析 user.shelf_ids），不再经 useScanShelfStore ——
// 目标货架已由后端按负载自动选择，「当前作业架」这个概念连同选架入口整体下线。
const shelvesQuery = useProductionShelvesQuery({ is_active: true, limit: 500 });
// 未加载完成期间不判定按钮显隐：此时按「无货架」算会先闪一屏「未绑定货架」。
// ⚠️ 必须带 `isPending`：`isFetching` 只覆盖「已经在飞」，而首帧（observer effect
// 跑之前）fetchStatus 还是 idle，两者皆假 ⇒ boundZones 算成空集 ⇒ 闪一屏零按钮
// 零文案。`isPending || isFetching` 覆盖「还没拿到过数据」与「正在刷新」两种窗口。
const shelfLoading = computed<boolean>(
  () => shelvesQuery.isPending.value || shelvesQuery.isFetching.value,
);

// 2026-07-13：boundZones = 绑定架 zone 的并集，决定按钮显隐
// - 含 PRODUCTION → PICK_UP + RETURN
// - 含 INSPECTION → INSPECT
const boundZones = computed<Set<string>>(() => {
  const bound = new Set(auth.boundShelves);
  const s = new Set<string>();
  for (const o of shelvesQuery.data.value?.items ?? []) {
    if (!bound.has(String(o.id))) continue;
    if (o.zone === 'PRODUCTION' || o.zone === 'INSPECTION') {
      s.add(o.zone);
    }
  }
  return s;
});
const showPickUp = computed<boolean>(() => boundZones.value.has('PRODUCTION'));
const showReturn = computed<boolean>(() => boundZones.value.has('PRODUCTION'));
const showInspect = computed<boolean>(() => boundZones.value.has('INSPECTION'));
const hasAnyAction = computed<boolean>(
  () => showPickUp.value || showReturn.value || showInspect.value,
);
/**
 * 三个按钮全隐藏时的原因说明。零按钮 + 零文案会让工人以为页面坏了。
 *
 * 2026-10-10：「当前作业货架」横条下线后，本页再没有第二处能摆「zone 认不出来」
 * 这条成因 ⇒ 只有「账号真的一个架都没绑」（wildcard）这一支留文案，其余静默。
 * 「绑了架但货架端点挂了」也静默：那时按钮该显示还是显示，让工人自己撞后端的
 * 错误提示，比一屏「无法识别」更可诊断（真因在 console 与网络面板里）。
 */
const noActionReason = computed<string | null>(() => {
  if (shelfLoading.value || hasAnyAction.value) return null;
  // 绑定集非空但一个 zone 都认不出来（货架端点失败 / 返回不全）：横条已下线，
  // 没有别处可摆这句，不说就是一屏零按钮 ⇒ 静默只当「有按钮」处理。
  if (auth.boundShelves.length > 0) return null;
  return '本账号未绑定货架，请联系管理员在「账号管理」为本账号绑定货架';
});

// 2026-10-11：「查看持有」按钮 + 它的角标。数据源是同一条 `qk.scanHeld`
// （params 与徽章 / 放回页 / 送检页逐字一致 ⇒ 同屏去重，本页不新增任何请求），
// `silent: true` 的错误由 `HeldPartsDialog` 渲染进面板，不在这里弹 toast。
// 只取 `items.length` 当角标：那是「已加载」的件数，后端 limit 截断时会小于 total，
// 但角标位没有空间写「已加载 N（共 M）」，且这个数字只用于「要不要点进去看看」。
const heldQuery = useScanHeldQuery(
  () => (worker.value?.id ? { workerId: String(worker.value.id), limit: 200 } : null),
  { silent: true },
);
const heldCount = computed(() => heldQuery.query.data.value?.items.length ?? 0);
const showHeld = computed<boolean>(() => !!worker.value?.id);
const heldDialogOpen = ref(false);

onBeforeMount(() => {
  // 不 await 货架请求：按钮显隐由 boundZones 派生，拉取在飞时 shelfLoading 为 true、
  // 三个按钮都不渲染，工人看到的是空转而不是「未绑定货架」。请求生命周期交给共享 query。
  if (!requireWorker(router)) return;
});

function selectAction(a: WorkAction): void {
  setAction(a);
  ElMessage.success(`已选择: ${ACTION_LABEL[a]}`);
  // 三个动作各自只做「记下选择 + 跳页」，选件 / 选工序 / 选架等后续步骤都在目标页。
  // PICK_UP → /scan/pick（按工种取可领件）
  // RETURN → /scan/return（持有件 → 选批次 → NEXT 免填工序 / 手选工序）
  // INSPECT → /scan/inspect（持有件 → 选批次 → 扫码确认）
  // 目标货架一律由后端按负载自动选，本页与三个目标页都没有选架步骤。
  // 送货入口在送货单列表页的「送货」按钮（扫码台无 DELIVER 分支）。
  if (a === 'PICK_UP') {
    void router.push('/scan/pick');
  } else if (a === 'RETURN') {
    void router.push('/scan/return');
  } else if (a === 'INSPECT') {
    void router.push('/scan/inspect');
  }
}

function rescanBadge(): void {
  // 不再需要清客户端缓存：findWorkerByBadge 直接打后端，结果强一致。
  reset();
  void router.replace('/scan/badge');
}
</script>

<style lang="scss" scoped>
.action-picker {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: #f5f7fa;
}

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

.content {
  flex: 1;
  overflow: auto;
  max-width: 1100px;
  width: 100%;
  margin: 0 auto;
  padding: 32px 24px;
}

.state-title {
  text-align: center;
  font-size: 26px;
  font-weight: 600;
  color: #303133;
  margin: 0 0 32px;
}

/**
 * 2×2 而不是一行 4 列（2026-10-11 有意选择）：`content` 最大宽 1100px、按钮高 240px，
 * 4 列时每列只有约 250px —— 放不下 48px 图标 + 28px 字距 4px 的标签 + 两行描述文案，
 * 文案会被挤成两行甚至截断。2×2 每列约 520px，宽裕；HMI 触屏上 2×2 也是更好按的排布。
 */
.action-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 24px;
}

.action-btn {
  height: 240px !important;
  display: flex !important;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  border-radius: 12px !important;
  font-size: 18px;
}

.action-label {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 4px;
  line-height: 1;
}

.action-desc {
  font-size: 13px;
  font-weight: 400;
  opacity: 0.85;
  margin-top: 4px;
}

/**
 * 只绑生产架时按钮是 3 个（取件 / 放回 / 查看持有），排成一行三列比塞进 2×2 留一个空洞
 * 好看。按钮数只可能是 2 / 3 / 4（`showPickUp` 与 `showReturn` 恒同真同假）。
 */
.action-grid--row {
  grid-template-columns: repeat(3, 1fr);
}
</style>
