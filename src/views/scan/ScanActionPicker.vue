<!--
  ScanActionPicker.vue

  /scan/action：选择报工操作（取件 / 放回 / 送检），并选定「当前作业货架」。
  入口守卫：worker 缺失则跳回 /scan/badge。

  按钮按「绑定架 zone 并集」显示（HMI 账号在账号管理页绑定的货架决定）：
    * 绑了任意 PRODUCTION 架 → PICK_UP + RETURN
    * 绑了任意 INSPECTION 架 → INSPECT
    * 两种 zone 都绑了 → 三个按钮全显示

  2026-09-15 Phase 5：RETURN / INSPECT 后端走 worker-scan（`POST /parts/worker-scan`，
  event_type=RETURNED / INSPECTED）二合一；PICK_UP 仍走 `POST /parts/pick-up`
  （B 方案手动 pick-up 兜底）。送货入口已移到 MANAGER/INSPECTOR 的「送货」菜单
  （/delivery-dispatch），扫码台不再有 DELIVER 操作。

  2026-10-04：**作业货架（只有送检要用）的选定入口在本页**。取件的 pick-up 已解绑
  （后端把 `shelf_id` 改成可选、缺省不做任何校验），放回的 `shelf_id` 来自放回链自己
  的货架 picker —— 两者都不经过 `useScanShelfStore`。
  - 顶部「当前作业货架」区三种形态：单架 → 「自动：{code}」不可换；多架未选 → 警示态
    +「选择货架」；多架已选 → 「当前：{code}」+「更换」。三态都常驻，工人随时能看清
    自己此刻报给系统的是哪个架。
  - 点「送检」时若 `showShelfSelector` 为真，**先开 `WorkingShelfDialog`** 让工人选，
    confirm 之后才 `router.push('/scan/inspect')`；cancel 则中止、留在本页。刻意不用
    按钮 disabled 代替 —— HMI 上置灰既让工人困惑、又没有任何出路提示。
  - ⚠️ 送检页的 `ShelfPickerDialog` 给的是**目标品检架**（worker-scan 的
    `target_inspection_shelf_id`），与本页这个「作业架」不是同一个东西，别混。
  - 候选为空（wildcard）时不额外渲染：走既有 `noActionReason` 分支。zone 一个都认不
    出来时三个按钮全隐藏（zone 未解析，见 store 的 initShelves 兜底）。
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
      <!-- 当前作业货架（只服务送检）：常驻显示当前值，多架未选时是警示态 + 选架入口 -->
      <div v-if="showWorkingShelfBar" :class="['working-shelf', { 'is-warn': needShelf }]">
        <el-icon :size="22"><Location /></el-icon>
        <span class="working-shelf-label">当前作业货架</span>
        <span class="working-shelf-value">{{ workingShelfText }}</span>
        <el-button
          v-if="canChangeShelf"
          size="default"
          :type="needShelf ? 'warning' : 'primary'"
          plain
          @click="openShelfSelector"
        >
          {{ needShelf ? '选择货架' : '更换' }}
        </el-button>
      </div>

      <h2 class="state-title">请选择报工操作</h2>
      <div v-if="shelfLoading" style="text-align: center; padding: 40px 0; color: #909399">
        加载货架信息...
      </div>
      <div v-else-if="noActionReason" style="text-align: center; padding: 40px 0; color: #909399">
        {{ noActionReason }}
      </div>
      <div v-else :class="['action-grid', { 'action-grid--two': !showInspect }]">
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
      </div>
    </div>

    <WorkingShelfDialog
      v-model="showShelfDialog"
      :options="scanShelf.options"
      @confirm="onWorkingShelfConfirm"
      @cancel="onWorkingShelfCancel"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeMount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Avatar, Back, Box, Check, Location, Refresh } from '@element-plus/icons-vue';
import { ACTION_LABEL, useScanSession, type WorkAction } from '@/composables/useScanSession';
import { useScanShelfStore } from '@/stores/scanShelf';
import WorkingShelfDialog from '@/views/scan/components/WorkingShelfDialog.vue';

const router = useRouter();
const { worker, setAction, reset, requireWorker } = useScanSession();
// 2026-10-04：候选架状态由 useScanShelfStore（Pinia 单例）承载 —— 本页是选架入口，
// 送检页（兄弟路由）读它时要 await initShelves，跨路由必须存活。
const scanShelf = useScanShelfStore();

const shelfLoading = ref(true);
const showShelfDialog = ref(false);

// 2026-07-13：boundZones = 绑定架 zone 的并集，决定按钮显隐
// - 含 PRODUCTION → PICK_UP + RETURN
// - 含 INSPECTION → INSPECT
const boundZones = computed<Set<string>>(() => {
  const s = new Set<string>();
  for (const o of scanShelf.options) {
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
/** 三个按钮全隐藏时的原因说明。零按钮 + 零文案会让工人以为页面坏了：候选为空（wildcard）
 *  与「候选有但 zone 一个都认不出来」（含 store 兜底填 UNKNOWN 的情形）都走这里。 */
const noActionReason = computed<string | null>(() => {
  if (shelfLoading.value || hasAnyAction.value) return null;
  return scanShelf.options.length === 0
    ? '本账号未绑定货架，请联系管理员在「账号管理」为本账号绑定货架'
    : '本账号绑定的货架所属区域无法识别，请联系管理员核对本账号的货架绑定';
});

// ===== 当前作业货架（只服务送检）=====

/** 已选中的架的 code；null = 未选 / 该架不在候选内。 */
const workingShelfCode = computed<string | null>(
  () => scanShelf.options.find((o) => o.id === scanShelf.selectedShelfId)?.code ?? null,
);
/** 多架且未选 = 需要工人去选一个（store 侧唯一表达该状态的判定）。 */
const needShelf = computed<boolean>(() => scanShelf.showShelfSelector);
/** 单架是唯一确定的选择，没有「换一个」这回事，不给按钮。 */
const canChangeShelf = computed<boolean>(() => scanShelf.options.length >= 2);
/** 候选为空时不额外渲染：那条路走 noActionReason 文案就够了，两处都渲染是重复噪音。 */
const showWorkingShelfBar = computed<boolean>(
  () => !shelfLoading.value && scanShelf.options.length > 0,
);
/** 单架 = 自动选出来的，不写「当前」而写「自动」：让工人知道这一栏他没得挑。多架未选
 *  直说「未选择」—— 少一个架号，工人就不知道系统此刻拿不到作业架（也就是送检发不出去）。 */
const workingShelfText = computed<string>(() => {
  if (needShelf.value) return '未选择';
  const label = workingShelfCode.value ?? scanShelf.selectedShelfId ?? '—';
  return canChangeShelf.value ? `当前：${label}` : `自动：${label}`;
});

function openShelfSelector(): void {
  showShelfDialog.value = true;
}

/** 「点送检 → 需要先选架」的中转标记：选完架由 onWorkingShelfConfirm 补上跳转。
 *  非响应式：它只在一次点击到弹窗回执之间有意义，不进模板。 */
let pendingInspect = false;

function onWorkingShelfConfirm(shelfId: string): void {
  showShelfDialog.value = false;
  // selectShelf 越界返回 false 且不写：与候选集不符的 id 进来时保留原状，不静默写坏值。
  if (!scanShelf.selectShelf(shelfId)) {
    ElMessage.error('该货架不在本账号的可用货架内，请重新选择');
    return;
  }
  // 选架是「进送检」的入口：确认选了架就把这次跳转补上，工人不必再点一次送检按钮。
  if (pendingInspect) {
    pendingInspect = false;
    void router.push('/scan/inspect');
  }
}

function onWorkingShelfCancel(): void {
  // 放弃选架 = 放弃进送检，留在本页；不 setAction，免得半途选了个动作却没进流程。
  pendingInspect = false;
}

onBeforeMount(async () => {
  if (!requireWorker(router)) return;
  // 拉候选架（绑定架详情；wildcard → 空；多架 → 先试 sessionStorage 恢复，恢复不回来
  // 就留给工人选）。store 内部按账号幂等，已加载过则不再重打 listShelves。
  await scanShelf.initShelves();
  shelfLoading.value = false;
});

function selectAction(a: WorkAction): void {
  // 2026-10-04：只有送检需要作业架。多架未选时先开选架弹窗，confirm 后由
  // onWorkingShelfConfirm 补上跳转；cancel 留在本页。**不把按钮置灰** —— HMI 上
  // 置灰既让工人困惑、又没给出路。
  if (a === 'INSPECT' && needShelf.value) {
    pendingInspect = true;
    showShelfDialog.value = true;
    return;
  }
  setAction(a);
  ElMessage.success(`已选择: ${ACTION_LABEL[a]}`);
  // PICK_UP 走「按工种选件」新流程 → /scan/pick（不依赖作业架）
  // RETURN 走「按工人列持有件 → 选件 → 选工序 → 选架」新流程 → /scan/return
  // INSPECT 走「按工人列持有件 → 选件 → 扫码确认 → 选品检架」新流程 → /scan/inspect
  // 送货入口已移到 MANAGER/INSPECTOR 的「送货」菜单（/delivery-dispatch）。
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

/* 当前作业货架条（只服务送检）。多架未选时转警示态，让「先选架再送检」在按钮之前就
   摆出来，而不是等点按钮被拦才被告知。 */
.working-shelf {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 24px;
  padding: 12px 18px;
  border-radius: 10px;
  background: #fff;
  border: 1px solid #e4e7ed;
  color: #606266;
  font-size: 16px;
  &.is-warn {
    background: #fdf6ec;
    border-color: #f5dab1;
    color: #e6a23c;
  }
}
.working-shelf-label {
  font-weight: 600;
}
.working-shelf-value {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-weight: 700;
  color: #303133;
}

.action-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
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

.action-grid--two {
  grid-template-columns: repeat(2, 1fr);
}
</style>
