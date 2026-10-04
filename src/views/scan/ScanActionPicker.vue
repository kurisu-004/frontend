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
  - 顶部「当前作业货架」区**按「作业架能不能提交」渲染**，判据复用送检页的
    `workingShelfProblem()`（与页内两处守卫同源）—— 不可提交时转警示态并把原因原话
    摆出来；可提交且只有一个候选显示「自动：{code}」，多个候选显示「当前：{code}」。
  - 警示态不只对应「多架未选」：**选中的是品检架**、**zone 未解析**两种同样落进来。
    只判「多架未选」会让「只绑了品检架」的账号显示「自动：SH-I02」—— 一个 worker-scan
    必然 20501 打回的架号，工人据此点进送检页才发现一次都提交不出去，而那一屏没有出路。
  - 只要**有候选**就给「选择货架 / 更换」按钮，不按架数：品检账号点开就能看到
    `WorkingShelfDialog` 的空态说明（指向「联系管理员绑定生产货架」），比一条没有按钮
    的警示横条更像出路。候选为空时整条横条不渲染（走 `noActionReason`）。
  - 点「送检」时若作业架不可提交，**先开 `WorkingShelfDialog`** 让工人选，confirm 之后
    才 `router.push('/scan/inspect')`；cancel 则中止、留在本页。刻意不用按钮 disabled 代替
    —— HMI 上置灰既让工人困惑、又没有任何出路提示。
  - ⚠️ 送检页的 `ShelfPickerDialog` 给的是**目标品检架**（worker-scan 的
    `target_inspection_shelf_id`），与本页这个「作业架」不是同一个东西，别混。
  - zone 一个都认不出来时三个按钮全隐藏（zone 未解析，见 store 的 initShelves 兜底）。
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
      <!-- 当前作业货架（只服务送检）：常驻显示当前值；作业架不可提交时转警示态 + 选架入口 -->
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
      :current-shelf-id="scanShelf.selectedShelfId"
      :empty-text="emptyShelfText ?? undefined"
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
import { workingShelfProblem } from '@/views/scan/composables/resolveWorkingShelf';
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
/**
 * 三个按钮全隐藏时的原因说明。零按钮 + 零文案会让工人以为页面坏了。
 *
 * 2026-10-04 review 第 2 轮：候选非空但 zone 一个都认不出来这一支改成返回 `null` ——
 * 那句文案与顶部横条摆的 `shelfProblem` 说的是同一件事（横条：「无法识别当前货架所属区域，
 * 不能作为作业货架…」），两处同时渲染就是同一屏两条近义长句。横条已经说了，这里不再重复。
 * 顺带覆盖掉「后端将来返一个本仓还不认识的新 zone」这一支：横条同样会兜住。
 *
 * wildcard（候选为空）那一支保持原样：那时横条整条不渲染（`showWorkingShelfBar` 要求
 * `options.length > 0`），这句话没有别处可去，删了就是一屏零字。
 */
const noActionReason = computed<string | null>(() => {
  if (shelfLoading.value || hasAnyAction.value) return null;
  if (scanShelf.options.length > 0) return null;
  return '本账号未绑定货架，请联系管理员在「账号管理」为本账号绑定货架';
});

// ===== 当前作业货架（只服务送检）=====

/** 已选中的架的 code；null = 未选 / 该架不在候选内。 */
const workingShelfCode = computed<string | null>(
  () => scanShelf.options.find((o) => o.id === scanShelf.selectedShelfId)?.code ?? null,
);
/**
 * 作业架当前不可提交的原因（null = 可提交）。直接复用送检页的守卫判定，本页与它同源
 * 才不会出现「横条说自动认定了一个架、送检页却 100% 拦死」这种各说各话。
 *
 * 2026-10-04 review 第 1 轮：原先这里判的是 store 的 `showShelfSelector`（= 多架且未选），
 * 于是「只绑了品检架」的账号（单架 ⇒ 自动选中 ⇒ 该判据为 false）落进正常态，横条显示
 * 「自动：SH-I02」—— 一个 worker-scan 必然 20501 打回的架号，看上去像是系统认定的。
 * 工人据此点进送检页后才被页内两处守卫拦死，而那一屏没有任何出路。改判「作业架不可用」
 * 之后，「多架未选 / 选中品检架 / zone 未解析」三种走同一条警示路径。
 *
 * `workingShelfProblem` 只读不弹提示（见 resolveWorkingShelf.ts 的约定），且本 computed 只在
 * 模板渲染时求值 —— 那时 `shelfLoading` 已转 false、`initShelves()` 已 await 完，读得到候选集。
 */
const shelfProblem = computed<string | null>(() => workingShelfProblem());
/** 作业架不可提交 ⇒ 横条转警示态，送检也先拦一道弹窗。 */
const needShelf = computed<boolean>(() => shelfProblem.value !== null);
/**
 * 选架入口的显隐：**只看有没有候选**，不按架数。品检账号只有品检架时同样要给出按钮 ——
 * 点开看到 `WorkingShelfDialog` 的空态说明（指向「联系管理员绑定生产货架」），比一条
 * 没有按钮的警示横条更像出路。候选为空时整条横条都不渲染（走 noActionReason），按钮
 * 也就无从出现。
 */
const canChangeShelf = computed<boolean>(() => scanShelf.options.length > 0);
/** 候选为空时不额外渲染：那条路走 noActionReason 文案就够了，两处都渲染是重复噪音。 */
const showWorkingShelfBar = computed<boolean>(
  () => !shelfLoading.value && scanShelf.options.length > 0,
);
/**
 * 作业架这一位怎么说话。
 * - 不可提交：把 `shelfProblem` 原话摆出来（多架未选 / 在品检区 / 区域未知），让工人在**点
 *   按钮之前**就知道送检发不出、以及为什么 —— 不必等进了送检页吃 error 才知道。
 * - 可提交且只有一个候选：「自动：{code}」，让工人知道这一栏他没得挑。
 * - 可提交且有多个候选：「当前：{code}」，并给「更换」。
 */
const workingShelfText = computed<string>(() => {
  if (shelfProblem.value) return shelfProblem.value;
  const label = workingShelfCode.value ?? scanShelf.selectedShelfId ?? '—';
  return scanShelf.options.length >= 2 ? `当前：${label}` : `自动：${label}`;
});

/**
 * 弹窗空态文案（null = 弹窗里有东西可列，文案用不上）。
 *
 * 2026-10-04 review 第 2 轮新增。判据是「候选里一个生产架都没有」这件事本身，**不是**
 * `shelfProblem()` —— 后者回答的是「为什么当前作业架不可提交」，空态要回答的是「为什么这里
 * 列不出一张货架卡」。两者在「绑了 ≥ 2 个架、但一个都不是生产区」时会分叉：那时守卫说的是
 * 「本账号绑定了多个货架，请先在「操作选择」页选择当前作业货架」，可工人此刻**正站在
 * 「操作选择」页**、弹窗里一张卡都没有 —— 让他去「选择货架」是循环指引，而选择根本解决不了
 * （没有生产架可选）。所以这里自己判、并且不替 zone 猜成因，只如实说「没有生产架 + 找谁」。
 *
 * 具体成因（都在品检区 / 所属区域暂未识别）由**背后的横条**给出：那里摆的是
 * `shelfProblem`，逐条区分「在品检区」与「无法识别所属区域」。两处各说一件事、互不矛盾。
 */
const emptyShelfText = computed<string | null>(() => {
  if (scanShelf.options.some((o) => o.zone === 'PRODUCTION')) return null;
  return '本账号绑定的货架里没有生产区作业货架（可能都在品检区，或所属区域暂未识别），请联系管理员核对本账号的货架绑定';
});

function openShelfSelector(): void {
  showShelfDialog.value = true;
}

/** 「点送检 → 需要先选架」的中转标记：选完架由 onWorkingShelfConfirm 补上跳转。
 *  非响应式：它只在一次点击到弹窗回执之间有意义，不进模板。
 *  2026-10-04 review 第 1 轮：**每条离开 pendingInspect 的路径都必须复位**（确认成功 /
 *  确认失败 / 取消）。漏掉失败那条的话，一次越界确认留下的 true 会让工人下一次点
 *  「更换」货架、随手 confirm 时被**意外带进送检页**。 */
let pendingInspect = false;

function onWorkingShelfConfirm(shelfId: string): void {
  showShelfDialog.value = false;
  // selectShelf 越界返回 false 且不写：与候选集不符的 id 进来时保留原状，不静默写坏值。
  if (!scanShelf.selectShelf(shelfId)) {
    ElMessage.error('该货架不在本账号的可用货架内，请重新选择');
    pendingInspect = false;
    return;
  }
  // 选架是「进送检」的入口：确认选了架就把这次跳转补上，工人不必再点一次送检按钮。
  //
  // ⚠️ 2026-10-04 review 第 2 轮登记：这里（以及上面失败/cancel 两条路径）都**刻意不调**
  // `setAction('INSPECT')`，与 `selectAction` 里 INSPECT 的常规路径不同。当前零功能后果 ——
  // `useScanSession` 的 `action` ref 唯一消费方是 `requireWorkerAndAction`，而它连同
  // `actionToSlug` / `slugToAction` **全仓零调用点**，`/scan/inspect` 自己只要求
  // `requireWorker`（见该页 onBeforeMount）。但这是个 latent trap：将来谁把
  // `requireWorkerAndAction` 接进 `/scan/inspect`，本路径就会因 `action` 为 null 被弹回
  // `/scan/action`，与「点送检 → 弹窗 → confirm → push」形成来回弹。接的时候记得在本行
  // 补上 `setAction('INSPECT')`。
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
  // 2026-10-04 review 第 2 轮：警示态摆的是守卫原话（最长一条 41 字），加上标签、图标、
  // 按钮约需 920px。`.content` 上限 1100px，1024px 屏放得下，**800px 屏放不下** —— 单行
  // flex 会把「选择货架」按钮挤出/裁掉，而那正是这类状态下唯一的出路。允许换行兜底。
  flex-wrap: wrap;
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
  // flex 子项默认 `min-width: auto`，长文本会把同行的按钮顶出去 ⇒ 必须显式给 0，
  // 否则上一条的 `flex-wrap` 在「标签 + 长文本 + 按钮」这一组合里也救不回来。
  min-width: 0;
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
