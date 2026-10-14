// @vitest-environment happy-dom
// src/views/outsource/components/__tests__/CandidatePool.spec.ts
//
// 外协看板「可发送候选池」的拖拽源接线 + 扫码选中 + 置灰守卫。
//
// 覆盖：
//   - C1：Sortable 用**三参重载**（带 list）—— 源侧必须有库内建 `onRemove` 才有
//     「把被拖节点放回源容器」这一层。改二参（或传 undefined 数组）后投放失败时节点
//     永久卡在落点列，且它不在 vnode 树里、Vue 重渲染与 invalidate 都清不掉。
//   - C2：group 是 `outsource-send` 且 put:false / pull:true（只拖出、不接投放）。
//   - C3：`filter: '.is-locked'` —— `shelf_id` 为空串（PENDING 未上架）的行不可拖。
//   - C4：sort:false（池内顺序由后端排定，无重排语义）。
//   - C5：`onStart` 经 dndSourceTracker 记下源条目 —— processId（容器 dataset）/
//     shelfId（卡片 dataset 的真实货架）/ version（卡片 dataset）/ companyId
//     （APPROVAL 报价锁定公司；DIRECT 行为空串）。
//   - C6：`onStart` 在卡片没带 data-batch-version 时记 **NaN** 而不是 0（0 是形态合法
//     的假 version，会让后端按 OCC 冲突 40901 拒一次用户没做错的投放；守卫在
//     useOutsourceQueueMove）。
//   - C7：`data-*` 透传 —— 容器带 data-process-id，卡片带 data-shelf-id /
//     data-batch-version（BatchCard 是 inheritAttrs:false + v-bind="$attrs"）。
//   - C8：勾选框翻转 → 换新 Set 上抛（多选集合是候选池与公司列共用的同一份）。
//   - C9：置灰行没有勾选角标（selectable=false）且点击不改变集合。
//   - C10：扫码命中 → 加入勾选；未命中 → warning 且文案点明「当前工序」作用域。
//   - C10b：**非当前 tab**（activeProcessId 不匹配）→ 完全无反应（切过的 tab 都还挂着，
//     不闸门就会一次扫码改掉 N 个 tab 的勾选）。
//   - C10c：扫到尚未上架的批次 → warning 且不勾选（勾上了也拖不动）。
//   - C11：Sortable 容器 .pool-cards 内只有卡片（无注释节点、无空态混入）；空池时容器
//     仍在（零元素子节点）且空态是兄弟覆盖层。
//   - C12：容器上不包任何组件（BatchCard 根就是 vnode 的 DOM footprint）—— 判据是卡
//     片根 div 的父节点就是 .pool-cards。
//   - C14：卡片右键 → 板级 opener 带**区域标签** `'outsource-candidate'` 与候选行上下文
//     （发送白名单的五条锚只在候选 DTO 上，卡片 model 里没有）；C14b：未 provide opener
//     时右键不抛错（inject 缺省 noop）。
//   - C15 / C16 / C17 / C18（2026-10-20）：序列号 / 图号 / 批次号 / 名称的**本地**过滤 ——
//     C15 只渲染命中的卡（三处计数口径保持全量）；C16 两条空态分支各说各的话且都在
//     .pool-cards 之外；C17 搜索行是 .pool-cards 的兄弟节点；C18 扫码命中被关键词过滤掉的
//     行 ⇒ 关键词自动清空（否则操作员「勾上了却看不见卡」）。
//   - C19 / C19b / C20 / C21 / C22（2026-10-20）：搜索框回车路径 ——
//     全局条码枪对输入框里的按键一律不派发（`useBarcodeScanner` 的 isInTextField），组件
//     头部新增搜索框后「点过搜索框再扫码」静默失效，故 `@keyup.enter` 把手输内容当一次
//     扫码提交并失焦。C19 手输未命中**保留关键词**且静默（与扫码枪的 C19b 提示分支对照，
//     也避免按名称/图号过滤后回车把过滤结果抹掉）；C20 命中复用扫码的匹配与勾选、清空
//     关键词；C21「尚未上架」守卫两条路径都保留；C22 两条路径的实例隔离。
//
// 测试策略：
//   - vi.mock('vue-draggable-plus') 复刻重载判别（照 WorkerColumn.spec.ts 同款），捕获
//     `{list, options}` 后手工驱动 `options.onStart(evt)`；
//   - dndSourceTracker 用**真实实现**：onStart 记 / 落点取的读写配对是被测行为的一半；
//   - EP 组件 stub + vi.mock('element-plus') 把 ElMessage 桩成 no-op；
//   - mountPool 挂载的实例由 afterEach 统一卸载：扫码枪是模块级单例，残留实例会同时收到
//     同一次扫码（既干扰「本用例只弹过一次」这类断言，也把 document.body 越堆越脏）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, nextTick, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { OutsourceQueueCandidateData } from '../../composables/outsourceQueueSchema';

const captured = vi.hoisted(() => ({
  calls: [] as { list: unknown; options: Record<string, unknown> }[],
  starts: [] as unknown[],
}));

vi.mock('vue-draggable-plus', () => ({
  // 复刻 vue-draggable-plus 的重载判定：第 2 参的 .value 是数组 ⇒ 三参（list）形态。
  useDraggable: (_el: unknown, listOrOptions: unknown, maybeOptions?: unknown) => {
    const candidate = (listOrOptions as { value?: unknown }) ?? {};
    const hasList = Array.isArray(candidate.value ?? listOrOptions);
    const options = (hasList ? maybeOptions : listOrOptions) as Record<string, unknown>;
    captured.calls.push({ list: hasList ? listOrOptions : null, options });
    return {
      option: () => undefined,
      destroy: () => undefined,
      start: (el?: unknown) => captured.starts.push(el),
      pause: () => undefined,
      resume: () => undefined,
    };
  },
}));

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import CandidatePool from '../CandidatePool.vue';
import { consumeOutsourceSource, recordOutsourceSource } from '@/utils/dndSourceTracker';
import {
  ACTIVE_OUTSOURCE_PROCESS_ID,
  NOT_SHELVED_HINT,
  OPEN_OUTSOURCE_BATCH_MENU,
  SCAN_MISS_HINT,
} from '../../outsourceBoardTypes';
// 扫码枪用**真实实现**（模块级单例）：onScan 订阅 / 卸载退订这条链本身就是被测行为，
// 桩掉等于把要守的东西一起桩掉。

const ElTagStub = defineComponent({
  name: 'ElTagStub',
  props: { size: String, type: String },
  setup:
    (_, { slots }) =>
    () =>
      h('span', { class: 'el-tag-stub' }, slots.default?.()),
});
const ElTooltipStub = defineComponent({
  name: 'ElTooltipStub',
  props: { content: { type: String }, placement: { type: String } },
  setup(props, { slots }) {
    return () =>
      h('div', { class: 'el-tooltip-stub', 'data-content': props.content }, [
        h('div', { class: 'el-tooltip-stub__body' }, slots.default?.()),
      ]);
  },
});
const ElEmptyStub = defineComponent({
  name: 'ElEmptyStub',
  props: { description: String, imageSize: Number },
  // description 透出成 data-description：两条空态分支各说各的话，断言要读得到文案本身
  //（EP 真实 el-empty 把 description 渲染成插画下方的一行字）。
  setup:
    (props, { slots }) =>
    () =>
      h(
        'div',
        { class: 'el-empty-stub', 'data-description': props.description ?? '' },
        slots.default?.(),
      ),
});
const ElCheckboxStub = defineComponent({
  name: 'ElCheckboxStub',
  props: { modelValue: { type: [Boolean, String, Number], default: false } },
  emits: ['change', 'click'],
  setup: (props, { slots, emit }) => {
    return () =>
      h(
        'span',
        {
          class: 'el-checkbox-stub',
          onClick: () => emit('change', !props.modelValue),
        },
        slots.default?.(),
      );
  },
});

// 搜索框桩：真 <input>，v-model 走 update:modelValue。prefixIcon / clearable / size
// 一并声明，避免未声明的 prop 落到 DOM 属性上。
// blur() 走 expose（EP 真实 el-input 也经 defineExpose 暴露 focus/blur/select/clear），
// 组件侧的回车路径要真的失焦 —— 焦点不离开输入框时全局条码枪对按键一律不派发，扫码持续
// 静默失效。调用次数记在 blurLog 里供断言读。
const blurLog = vi.hoisted(() => ({ calls: 0 }));
const ElInputStub = defineComponent({
  name: 'ElInputStub',
  props: {
    modelValue: { type: String, default: '' },
    placeholder: String,
    size: String,
    clearable: Boolean,
    prefixIcon: { type: Object, default: undefined },
  },
  emits: ['update:modelValue'],
  setup(props, { emit, expose }) {
    expose({ blur: () => { blurLog.calls += 1; } });
    return () =>
      h('input', {
        class: 'el-input-stub__input',
        value: props.modelValue,
        placeholder: props.placeholder ?? '',
        onInput: (evt: Event) => emit('update:modelValue', (evt.target as HTMLInputElement).value),
      });
  },
});

const globalConfig = {
  components: {
    ElTag: ElTagStub,
    ElTooltip: ElTooltipStub,
    ElEmpty: ElEmptyStub,
    ElCheckbox: ElCheckboxStub,
    ElInput: ElInputStub,
  },
};

const PROCESS_ID = '2000000000001';
const SHELF_ID = '5000000000001';
const APPROVAL_COMPANY = '9000000000001';

/** 本 spec 用 mountPool 挂载、并在用例里显式 unmount 的实例集合（见文件尾的 afterEach）。
 *  扫码枪是**模块级单例**：不卸载的实例会一直留在它的订阅表里，同一次扫码会命中它们 ——
 *  既让「本用例只弹过一次」这类断言失去判定力，也把 document.body 越堆越脏。 */
const mountedPools = new Set<VueWrapper>();

function makeCandidate(
  overrides: Partial<OutsourceQueueCandidateData> = {},
): OutsourceQueueCandidateData {
  return {
    version: 3,
    send_mode: 'APPROVAL',
    part_id: '4000000000001',
    part_serial_no: 'SN-0001',
    part_drawing_no: 'DRW-1',
    part_name: '连杆',
    quantity: 12,
    batch_id: '3000000000001',
    batch_no: 1024,
    planned_delivery_date: '2026-10-20',
    is_urgent: false,
    has_process_chain: true,
    customer_name: '某某零件厂',
    customer_path: '某某分厂 / 某某零件厂',
    parent_customer_name: '某某集团',
    shelf_code: 'A-01',
    shelf_id: SHELF_ID,
    outsource_company_id: APPROVAL_COMPANY,
    outsource_company_name: '外协厂甲',
    quote_id: '7000000000001',
    company_options: [],
    price: '12.50',
    has_cnc_program: true,
    applicant_name: '张三',
    note: null,
    system_delivery_date: '2026-10-18',
    can_send: true,
    ...overrides,
  };
}

/** `PENDING` 未上架：shelf_id 是**空串**（不是 null），候选池里仍会出现。 */
function makeNotShelved(overrides: Partial<OutsourceQueueCandidateData> = {}) {
  return makeCandidate({
    batch_id: '3000000000009',
    batch_no: 9,
    part_serial_no: 'SN-0009',
    shelf_id: '',
    shelf_code: null,
    send_mode: 'DIRECT',
    outsource_company_id: null,
    outsource_company_name: null,
    quote_id: null,
    company_options: [{ id: '9000000000002', name: '外协厂乙' }],
    can_send: true,
    ...overrides,
  });
}

function mountPool(
  items: OutsourceQueueCandidateData[],
  selectedIds: Set<string> = new Set(),
  activeProcessId: string = PROCESS_ID,
  extraProvide: Record<string, unknown> = {},
) {
  const wrapper = mount(CandidatePool, {
    props: {
      items,
      processName: '外协热处理',
      processId: PROCESS_ID,
      selectedIds,
    },
    attachTo: document.body,
    global: {
      components: globalConfig.components,
      provide: {
        [ACTIVE_OUTSOURCE_PROCESS_ID]: computed(() => activeProcessId),
        ...extraProvide,
      },
    },
  });
  mountedPools.add(wrapper);
  return wrapper;
}

/** 造一个形状与 Sortable 原生 onStart 事件一致的最小载荷。 */
function dragEvent(dataset: { batchId: string; shelfId?: string; version?: number }) {
  const item = document.createElement('div');
  item.dataset.batchId = dataset.batchId;
  if (dataset.shelfId !== undefined) item.dataset.shelfId = dataset.shelfId;
  if (dataset.version !== undefined) item.dataset.batchVersion = String(dataset.version);
  const from = document.createElement('div');
  from.dataset.processId = PROCESS_ID;
  return { item, from };
}

function capturedOptions(): Record<string, unknown> {
  expect(captured.calls).toHaveLength(1);
  return captured.calls[0]!.options;
}

/** 造一个最小父级，把 CandidatePool 的 emit 接住（断言上抛的新 Set）。
 *
 *  用 render 函数而不是 inline `template`：vitest 下 `vue` 解析到 runtime-only 构建，
 *  运行时模板编译不可用（仓内其它组件 spec 同样一律 h() / defineComponent，见
 *  WorkerColumn.spec.ts）。 */
function mountedParent(items: OutsourceQueueCandidateData[], activeProcessId: string = PROCESS_ID) {
  const selectedIds = ref<Set<string>>(new Set());
  const wrapper = mount(
    {
      setup() {
        return () =>
          h(CandidatePool, {
            items,
            processName: '外协热处理',
            processId: PROCESS_ID,
            selectedIds: selectedIds.value,
            'onUpdate:selectedIds': (v: Set<string>) => {
              selectedIds.value = v;
            },
          });
      },
    },
    {
      global: {
        components: globalConfig.components,
        provide: {
          [ACTIVE_OUTSOURCE_PROCESS_ID]: computed(() => activeProcessId),
        },
      },
    },
  );
  return { wrapper, selectedIds };
}

beforeEach(() => {
  // ElMessage 是模块级 vi.fn()，跨用例累积调用会把「本用例没弹过」变成假红。
  vi.clearAllMocks();
  captured.calls.length = 0;
  captured.starts.length = 0;
  blurLog.calls = 0;
  // 扫码枪是模块级单例：缓冲区在每次 Enter 后由 handleKeyDown 自己 resetBuffer
  // 清空，跨用例不会残留（末位字符的 `lastTime` 也不影响判定 —— 超时分支只是把缓冲区
  // 重启成当前字符，后续字符仍在 30ms 窗口内追加）。
});

afterEach(() => {
  // 统一收掉本 spec 挂载的实例：漏掉的那几个会继续订阅模块级扫码枪并挂在 document.body
  // 上。用例里已经显式 unmount 的跳过（重复 unmount 只会刷一条 Vue 的 dev 警告）。
  for (const wrapper of mountedPools) {
    if (wrapper.vm?.$?.isUnmounted !== true) wrapper.unmount();
  }
  mountedPools.clear();
});

describe('CandidatePool（外协候选池：拖拽源）', () => {
  it('C1：Sortable 用三参重载（带 list），源侧才有内建 onRemove 的 DOM 放回', () => {
    mountPool([makeCandidate()]);
    // 三参形态 ⇒ 传给 useDraggable 的第 2 参是一个 ref 数组。
    expect(captured.calls[0]!.list).not.toBeNull();
    expect(Array.isArray((captured.calls[0]!.list as { value: unknown[] }).value)).toBe(true);
  });

  it('C2：group = outsource-send 且 put:false / pull:true', () => {
    mountPool([makeCandidate()]);
    expect(capturedOptions().group).toEqual({
      name: 'outsource-send',
      put: false,
      pull: true,
    });
  });

  it('C3：filter 拦掉置灰行（尚未上架的批次不可拖）', () => {
    mountPool([makeCandidate(), makeNotShelved()]);
    // 守卫依赖 filter 选择器与卡片上的 is-locked 类同时存在，少一条都失效：
    // 没有 filter ⇒ 置灰卡照样能拖起来；没有类名 ⇒ filter 命中不到。
    expect(capturedOptions().filter).toBe('.is-locked');
    const cards = document.body.querySelectorAll('.pool-cards .batch-card');
    const locked = Array.from(cards).filter((el) => el.classList.contains('is-locked'));
    expect(locked).toHaveLength(1);
  });

  it('C4：sort:false（池内顺序由后端排定，无重排语义）', () => {
    mountPool([makeCandidate()]);
    expect(capturedOptions().sort).toBe(false);
  });

  it('C5：onStart 记下源条目（processId / shelfId / version / companyId）', () => {
    const items = [makeCandidate()];
    mountPool(items);
    (capturedOptions().onStart as (e: unknown) => void)(
      dragEvent({ batchId: '3000000000001', shelfId: SHELF_ID, version: 3 }),
    );
    expect(consumeOutsourceSource('3000000000001')).toEqual({
      processId: PROCESS_ID,
      shelfId: SHELF_ID,
      version: 3,
      companyId: APPROVAL_COMPANY,
    });
  });

  it('C5b：DIRECT 行的 companyId 记空串（目标公司要在落点上才定）', () => {
    const direct = makeCandidate({
      send_mode: 'DIRECT',
      outsource_company_id: null,
      outsource_company_name: null,
      quote_id: null,
      company_options: [{ id: '9000000000002', name: '外协厂乙' }],
    });
    mountPool([direct]);
    (capturedOptions().onStart as (e: unknown) => void)(
      dragEvent({ batchId: direct.batch_id, shelfId: SHELF_ID, version: 7 }),
    );
    expect(consumeOutsourceSource(direct.batch_id)).toEqual({
      processId: PROCESS_ID,
      shelfId: SHELF_ID,
      version: 7,
      companyId: '',
    });
  });

  it('C6：卡片没带 data-batch-version → 记 NaN 而不是 0（守卫在 useOutsourceQueueMove）', () => {
    mountPool([makeCandidate()]);
    (capturedOptions().onStart as (e: unknown) => void)(
      dragEvent({ batchId: '3000000000001', shelfId: SHELF_ID }),
    );
    const src = consumeOutsourceSource('3000000000001');
    expect(src).toBeDefined();
    expect(src!.version).toBeNaN();
  });

  it('C6b：卡片没带 data-shelf-id → shelfId 记空串（不是 undefined）', () => {
    mountPool([makeCandidate()]);
    (capturedOptions().onStart as (e: unknown) => void)(
      dragEvent({ batchId: '3000000000001', version: 3 }),
    );
    expect(consumeOutsourceSource('3000000000001')?.shelfId).toBe('');
  });

  it('C7：容器带 data-process-id，卡片带 data-shelf-id / data-batch-version', () => {
    mountPool([makeCandidate()]);
    const container = document.body.querySelector('.pool-cards') as HTMLElement;
    expect(container.dataset.processId).toBe(PROCESS_ID);
    const card = document.body.querySelector('.batch-card') as HTMLElement;
    expect(card.dataset.batchId).toBe('3000000000001');
    expect(card.dataset.shelfId).toBe(SHELF_ID);
    expect(card.dataset.batchVersion).toBe('3');
  });

  it('C8：勾选框翻转 → 换新 Set 上抛（选中与取消都试）', async () => {
    const items = [makeCandidate(), makeCandidate({ batch_id: '3000000000002', batch_no: 2 })];
    const { wrapper, selectedIds } = mountedParent(items);
    const cards = wrapper.findAll('.el-checkbox-stub');
    expect(cards).toHaveLength(2);
    await cards[0]!.trigger('click');
    expect(Array.from(selectedIds.value)).toEqual(['3000000000001']);
    // 第二次点同一张 = 取消，且集合是**新对象**（父级响应式 Set 靠换引用触发）
    await wrapper.findAll('.el-checkbox-stub')[0]!.trigger('click');
    expect(selectedIds.value.size).toBe(0);
    expect(selectedIds.value).not.toBe(new Set());
    wrapper.unmount();
  });

  it('C9：置灰行没有勾选角标（selectable=false）且点击不改集合', async () => {
    const { wrapper, selectedIds } = mountedParent([makeNotShelved()]);
    expect(wrapper.findAll('.el-checkbox-stub')).toHaveLength(0);
    // 纵深防御：即便 somehow 触发了 toggleSelect，集合也不能变
    await wrapper.findComponent({ name: 'BatchCard' }).vm.$emit('toggleSelect');
    expect(selectedIds.value.size).toBe(0);
    wrapper.unmount();
  });

  it('C10：扫码命中当前 tab → 加入勾选；未命中 → warning（文案点明「当前工序」作用域）', async () => {
    const { ElMessage } = await import('element-plus');
    const items = [makeCandidate()];
    const { wrapper, selectedIds } = mountedParent(items);
    fireScan('SN-0001');
    await nextTick();
    expect(Array.from(selectedIds.value)).toEqual(['3000000000001']);

    fireScan('SN-9999');
    await nextTick();
    // 未命中文案必须点明「只在当前工序匹配」—— 不写清的话操作员会去查状态 / 报价
    expect(ElMessage.warning).toHaveBeenCalledWith(SCAN_MISS_HINT);
    wrapper.unmount();
  });

  it('C10c：扫到尚未上架的批次 → warning 且不勾选（勾上了也拖不动）', async () => {
    const { ElMessage } = await import('element-plus');
    const { wrapper, selectedIds } = mountedParent([makeCandidate(), makeNotShelved()]);
    fireScan('SN-0009');
    await nextTick();
    expect(selectedIds.value.size).toBe(0);
    expect(ElMessage.warning).toHaveBeenCalledWith(NOT_SHELVED_HINT);
    wrapper.unmount();
  });

  it('C10b：非当前 tab（activeProcessId 不匹配）→ 扫码完全无反应', async () => {
    const { ElMessage } = await import('element-plus');
    const items = [makeCandidate()];
    // 另一个 tab 的实例：候选行相同但 activeProcessId 不同（切过的 tab 都还挂着）
    const { wrapper, selectedIds } = mountedParent(items, '2000000000999');
    fireScan('SN-0001');
    await nextTick();
    expect(selectedIds.value.size).toBe(0);
    expect(ElMessage.warning).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('C11：Sortable 容器内只有卡片（无注释节点、无空态混入）；空池时容器仍在', () => {
    const wrapper = mountPool([makeCandidate(), makeCandidate({ batch_id: '3000000000002' })]);
    const container = wrapper.find('.pool-cards').element as HTMLElement;
    const nodes = Array.from(container.childNodes);
    expect(nodes.filter((n) => n.nodeType === Node.ELEMENT_NODE)).toHaveLength(2);
    expect(nodes.filter((n) => n.nodeType === Node.COMMENT_NODE)).toHaveLength(0);
    wrapper.unmount();

    // 空池：容器仍在（它是 Sortable 实例的载体）+ 空态是兄弟覆盖层
    const empty = mountPool([]);
    const col = empty.find('.pool-cards').element as HTMLElement;
    expect(col.children).toHaveLength(0);
    expect(Array.from(col.childNodes).filter((n) => n.nodeType === Node.COMMENT_NODE)).toHaveLength(
      0,
    );
    expect(empty.find('.pool-empty').exists()).toBe(true);
    expect(empty.find('.pool-empty').element.closest('.pool-cards')).toBeNull();
    empty.unmount();
  });

  it('C12：卡片根就是 vnode footprint（未被任何组件包裹），未上架提示在容器外的 tooltip', () => {
    const wrapper = mountPool([makeCandidate(), makeNotShelved()]);
    // 卡片父节点就是 Sortable 容器：BatchCard 的 tooltip 在根**内部**，根上也不许有
    // 别的元素（守卫 BatchCardDndFootprint.spec.ts）。
    const card = wrapper.findAll('.pool-cards .batch-card')[0]!;
    expect((card.element as HTMLElement).parentElement?.classList.contains('pool-cards')).toBe(
      true,
    );
    // 尚未上架的提示：容器外的 el-tooltip（包裹卡片会破坏 DnD 不变式）
    const tip = wrapper.find('.pool-toolbar .el-tooltip-stub');
    expect(tip.exists()).toBe(true);
    expect(tip.attributes('data-content')).toBe('该批次尚未上架，暂时不能发送到外协');
    expect(tip.element.closest('.pool-cards')).toBeNull();
    wrapper.unmount();
  });

  it('C13：onStart 不写任何未被识别来源的批次（dataset 缺 batchId 时早退）', () => {
    mountPool([makeCandidate()]);
    const item = document.createElement('div');
    const from = document.createElement('div');
    from.dataset.processId = PROCESS_ID;
    (capturedOptions().onStart as (e: unknown) => void)({ item, from });
    // consume 一次确认没有条目留下（早退 ⇒ 未 record）
    recordOutsourceSource('sentinel', {
      processId: PROCESS_ID,
      shelfId: '',
      version: 1,
      companyId: '',
    });
    expect(consumeOutsourceSource('sentinel')).toBeDefined();
  });

  it('C14：卡片右键 → opener 带区域标签 + 候选行上下文被调一次', async () => {
    const openOutsourceBatchMenu = vi.fn();
    // 两张卡（batch_id 不同）且右键**第二张**：单卡场景下「拿到那张行」与「拿到唯一那张行」
    // 无法区分，实现误传 items[0] 也会照样通过。
    const first = makeCandidate({ batch_id: '3000000000001' });
    const second = makeCandidate({ batch_id: '3000000000002' });
    const wrapper = mountPool([first, second], new Set(), PROCESS_ID, {
      [OPEN_OUTSOURCE_BATCH_MENU]: openOutsourceBatchMenu,
    });
    const cards = wrapper.findAll('.pool-cards .batch-card');
    expect(cards).toHaveLength(2);
    await cards[1]!.trigger('contextmenu', { clientX: 240, clientY: 180 });

    expect(openOutsourceBatchMenu).toHaveBeenCalledTimes(1);
    const call = openOutsourceBatchMenu.mock.calls[0]! as [
      MouseEvent,
      { batch_id: string },
      string,
      { kind: string; candidate: { batch_id: string }; processName: string },
    ];
    expect(call[0].clientX).toBe(240);
    // 第三参是容器恒定的区域标签（板级靠它派菜单矩阵；两处卡片字段集一样，只能由容器给）
    expect(call[2]).toBe('outsource-candidate');
    // 第四参带候选行 DTO —— 发送白名单的五条锚都在它上面，卡片 model 上没有
    expect(call[3].kind).toBe('candidate');
    expect(call[3].candidate.batch_id).toBe('3000000000002');
    expect(call[3].processName).toBe('外协热处理');
    expect(call[1].batch_id).toBe('3000000000002');
    wrapper.unmount();
  });

  it('C14b：未 provide opener 时右键不抛错（inject 缺省 noop）', async () => {
    const wrapper = mountPool([makeCandidate()]);
    await expect(
      wrapper.find('.pool-cards .batch-card').trigger('contextmenu'),
    ).resolves.not.toThrow();
    wrapper.unmount();
  });

  // ── 2026-10-20：本地关键词过滤（序列号 / 图号 / 批次号 / 名称） ─────────────────
  it('C15：输入关键词只渲染命中的卡（四字段各自命中都试；三处计数口径保持全量）', async () => {
    const wrapper = mountPool([
      makeCandidate({
        batch_id: '3000000000001',
        part_serial_no: 'SN-A',
        part_drawing_no: 'DRW-1',
      }),
      makeCandidate({
        batch_id: '3000000000002',
        batch_no: 2048,
        part_serial_no: 'SN-B',
        part_drawing_no: 'DRW-2',
        part_name: '齿轮',
      }),
      makeCandidate({
        batch_id: '3000000000003',
        batch_no: 4096,
        part_serial_no: null,
        part_drawing_no: 'DRW-3',
        part_name: '轴承',
      }),
      makeNotShelved({ batch_id: '3000000000004', part_serial_no: 'SN-D', part_name: '卡板' }),
    ]);
    const search = () => wrapper.find('.el-input-stub__input');
    const renderedIds = () =>
      wrapper.findAll('.pool-cards .batch-card').map((el) => el.attributes('data-batch-id'));

    expect(renderedIds()).toHaveLength(4);
    // 过滤前的工具条基线：徽标 4 / 未上架 1 / 已选 0
    expect(wrapper.find('.el-tag-stub').text()).toBe('4');

    await search().setValue('sn-b');
    expect(renderedIds()).toEqual(['3000000000002']);

    await search().setValue('DRW-3');
    expect(renderedIds()).toEqual(['3000000000003']);

    // 批次号：候选 DTO 是数字，卡片 model 上是适配层补过 B 前缀的串
    await search().setValue('B4096');
    expect(renderedIds()).toEqual(['3000000000003']);

    await search().setValue('连杆');
    expect(renderedIds()).toEqual(['3000000000001']);

    // 未上架的行同样可被搜索命中（过滤只管可见，不管可拖 —— is-locked 与 filter 选项不动）
    await search().setValue('卡板');
    const locked = wrapper.find('.pool-cards .batch-card');
    expect(renderedIds()).toEqual(['3000000000004']);
    expect(locked.classes()).toContain('is-locked');

    // 清空 → 回到全量；工具条三处计数都读 items，不随过滤变
    await search().setValue('');
    expect(renderedIds()).toHaveLength(4);
    expect(wrapper.find('.el-tag-stub').text()).toBe('4');
    expect(wrapper.text()).toContain('1 个尚未上架');
    expect(wrapper.text()).toContain('已选 0 件');
    await search().setValue('SN-B');
    expect(wrapper.find('.el-tag-stub').text()).toBe('4');
    expect(wrapper.text()).toContain('1 个尚未上架');
    wrapper.unmount();
  });

  it('C16：两条空态分支（无候选 / 无匹配）各说各的话，且都在 .pool-cards 之外', async () => {
    // 分支一：本来就没有候选 —— 走「该工序暂无可发送候选」
    const empty = mountPool([]);
    expect(empty.find('.el-empty-stub').attributes('data-description')).toBe(
      '该工序暂无可发送候选',
    );
    expect(empty.find('.pool-cards').exists()).toBe(true);
    expect(empty.find('.pool-empty').element.closest('.pool-cards')).toBeNull();
    empty.unmount();

    // 分支二：有候选但被关键词全部过滤掉 —— 走「无匹配…」，容器仍在（Sortable 实例载体）
    const wrapper = mountPool([
      makeCandidate({ batch_id: '3000000000001', part_serial_no: 'SN-A' }),
      makeCandidate({ batch_id: '3000000000002', part_serial_no: 'SN-B' }),
    ]);
    await wrapper.find('.el-input-stub__input').setValue('ZZZ-不存在');

    expect(wrapper.findAll('.pool-cards .batch-card')).toHaveLength(0);
    const overlay = wrapper.find('.pool-empty');
    expect(overlay.exists()).toBe(true);
    expect(overlay.find('.el-empty-stub').attributes('data-description')).toContain('无匹配');
    const container = wrapper.find('.pool-cards').element as HTMLElement;
    expect(container.children).toHaveLength(0);
    expect(overlay.element.closest('.pool-cards')).toBeNull();
    // 只有一条覆盖层在屏（v-if / v-else-if 两分支互斥）
    expect(wrapper.findAll('.pool-empty')).toHaveLength(1);
    wrapper.unmount();
  });

  it('C17：搜索行是 .pool-cards 的兄弟节点（容器内不许混非可拖子元素）', async () => {
    const wrapper = mountPool([makeCandidate()]);
    const row = wrapper.find('.pool-search');
    expect(row.exists()).toBe(true);
    const rowEl = row.element as HTMLElement;
    const container = wrapper.find('.pool-cards').element as HTMLElement;
    expect(rowEl.closest('.pool-cards')).toBeNull();
    expect(container.contains(rowEl)).toBe(false);
    // 搜索行挂在 .pool-body 之外（工具条已排满 30% 窄栏，搜索独占一行）
    expect(rowEl.parentElement?.classList.contains('candidate-pool')).toBe(true);
    expect(rowEl.parentElement?.classList.contains('pool-body')).not.toBe(true);
    expect(rowEl.closest('.pool-toolbar')).toBeNull();
    wrapper.unmount();
  });

  it('C18：扫码命中被关键词过滤掉的行 → 关键词自动清空（勾上了得看得见卡）', async () => {
    const { ElMessage } = await import('element-plus');
    const items = [
      makeCandidate({ batch_id: '3000000000001', part_serial_no: 'SN-0001', part_name: '连杆' }),
      makeCandidate({ batch_id: '3000000000002', part_serial_no: 'SN-0002', part_name: '齿轮' }),
    ];
    const { wrapper, selectedIds } = mountedParent(items);
    const search = () => wrapper.find('.el-input-stub__input');

    // 关键词把被扫中的那张卡挡掉了
    await search().setValue('齿轮');
    expect(wrapper.findAll('.pool-cards .batch-card')).toHaveLength(1);

    fireScan('SN-0001');
    await nextTick();

    // 命中行仍按全量 items 匹配并勾上（勾选集合是全量口径），同时关键词被清空 ⇒ 卡片回到可见
    expect(Array.from(selectedIds.value)).toEqual(['3000000000001']);
    expect((search().element as HTMLInputElement).value).toBe('');
    expect(wrapper.findAll('.pool-cards .batch-card')).toHaveLength(2);
    // 提示与界面必须同时自洽 ⇒ 成功文案照常弹
    expect(ElMessage.success).toHaveBeenCalledWith(expect.stringContaining('已选中'));
    wrapper.unmount();
  });

  it('C18b：扫码命中的行本来就在可见集里 → 关键词保持不变（不打断连续扫码）', async () => {
    const items = [
      makeCandidate({ batch_id: '3000000000001', part_serial_no: 'SN-0001', part_name: '连杆' }),
      makeCandidate({ batch_id: '3000000000002', part_serial_no: 'SN-0002', part_name: '齿轮' }),
    ];
    const { wrapper, selectedIds } = mountedParent(items);
    await wrapper.find('.el-input-stub__input').setValue('齿轮');

    fireScan('SN-0002');
    await nextTick();

    expect(Array.from(selectedIds.value)).toEqual(['3000000000002']);
    expect((wrapper.find('.el-input-stub__input').element as HTMLInputElement).value).toBe('齿轮');
    expect(wrapper.findAll('.pool-cards .batch-card')).toHaveLength(1);
    wrapper.unmount();
  });

  // ── 2026-10-20：搜索框回车路径（「点搜索框后扫码静默失效」的补偿） ─────────────────
  it('C19：手输未命中回车 → 关键词**保留** + 静默（不弹 SCAN_MISS_HINT）+ 失焦', async () => {
    // 反向验证：把 onSearchEnter 的清空挪回「无条件先清」时本条必须红。
    const { ElMessage } = await import('element-plus');
    const items = [
      makeCandidate({ batch_id: '3000000000001', part_serial_no: 'SN-0001', part_name: '连杆' }),
      makeCandidate({ batch_id: '3000000000002', part_serial_no: 'SN-0002', part_name: '齿轮' }),
    ];
    const { wrapper, selectedIds } = mountedParent(items);
    const search = () => wrapper.find('.el-input-stub__input');

    // 格一：输入的是一个**不存在的序列号**
    await search().setValue('SN-9999');
    await search().trigger('keyup', { key: 'Enter' });
    await nextTick();

    // 手输半截图号再回车是正常动作，弹「扫不到」等于骂人 ⇒ 未命中静默
    expect(ElMessage.warning).not.toHaveBeenCalled();
    expect(ElMessage.success).not.toHaveBeenCalled();
    expect(selectedIds.value.size).toBe(0);
    // 失焦是恢复扫码派发的必要动作（焦点留在输入框上时条码枪的按键一律不派发）
    expect(blurLog.calls).toBe(1);
    // 关键词**保留**：没命中就没理由清掉用户正在用的过滤词
    expect((search().element as HTMLInputElement).value).toBe('SN-9999');

    // 格二（这条才是真正的回归）：按**名称**过滤出一张卡后顺手回车 —— 搜索框承诺
    // 「序列号 / 图号 / 批次号 / 名称」，而回车路径只认 part_serial_no 等值。先清关键词
    // 就等于零反馈地抹掉用户刚做的过滤：卡片弹回全量、连提示都没有。
    await search().setValue('齿轮');
    expect(wrapper.findAll('.pool-cards .batch-card')).toHaveLength(1);
    await search().trigger('keyup', { key: 'Enter' });
    await nextTick();

    expect(ElMessage.warning).not.toHaveBeenCalled();
    expect(ElMessage.success).not.toHaveBeenCalled();
    expect(selectedIds.value.size).toBe(0);
    expect(blurLog.calls).toBe(2);
    expect((search().element as HTMLInputElement).value).toBe('齿轮');
    expect(wrapper.findAll('.pool-cards .batch-card')).toHaveLength(1);
    wrapper.unmount();
  });

  it('C19b：扫码枪扫不到仍弹 SCAN_MISS_HINT（两条路径只在「未命中要不要提示」上分叉）', async () => {
    // C19 的对照：C19 把扫码枪那条路的提示拿掉（notifyMiss 恒 false）时本条必须红。
    const { ElMessage } = await import('element-plus');
    const { wrapper } = mountedParent([makeCandidate()]);
    fireScan('SN-9999');
    await nextTick();
    expect(ElMessage.warning).toHaveBeenCalledWith(SCAN_MISS_HINT);
    wrapper.unmount();
  });

  it('C20：手输命中回车 → 勾选生效 + 成功提示沿用现有文案（复用扫码的匹配与勾选）', async () => {
    const { ElMessage } = await import('element-plus');
    const items = [makeCandidate({ part_serial_no: 'SN-0001', part_name: '连杆', batch_no: 1024 })];
    const { wrapper, selectedIds } = mountedParent(items);
    const search = () => wrapper.find('.el-input-stub__input');

    await search().setValue('  SN-0001  ');
    await search().trigger('keyup', { key: 'Enter' });
    await nextTick();

    // 匹配与扫码同款（含 trim），勾选集合照常换新 Set 上抛
    expect(Array.from(selectedIds.value)).toEqual(['3000000000001']);
    expect(ElMessage.success).toHaveBeenCalledWith(expect.stringContaining('已选中'));
    expect(ElMessage.warning).not.toHaveBeenCalled();
    expect(blurLog.calls).toBe(1);
    expect((search().element as HTMLInputElement).value).toBe('');
    wrapper.unmount();
  });

  it('C21：手输尚未上架的批次回车 → 仍弹 NOT_SHELVED_HINT 且不勾选（守卫两条路径都保留）', async () => {
    // 勾上了却拖不动比直接提示更差，所以「尚未上架」不允许在回车路径上被静默豁免。
    const { ElMessage } = await import('element-plus');
    const { wrapper, selectedIds } = mountedParent([makeNotShelved()]);
    const search = () => wrapper.find('.el-input-stub__input');

    await search().setValue('SN-0009');
    await search().trigger('keyup', { key: 'Enter' });
    await nextTick();

    expect(selectedIds.value.size).toBe(0);
    expect(ElMessage.warning).toHaveBeenCalledWith(NOT_SHELVED_HINT);
    wrapper.unmount();
  });

  it('C22：回车只清空自己这个实例的关键词（未激活 tab 的输入框拿不到焦点，不需要闸门）', async () => {
    // 非当前 tab 的实例：回车路径刻意不过 activeProcessId 闸门（扫码是全局的才需要闸门，
    // 回车只派发给本实例的输入框）。这里钉住「一个实例的清空不会动另一个实例的关键词」。
    // 两个实例各自持有一条**能被回车命中**的序列号（命中才清空，未命中按 C19 保留），
    // 否则这条会退化成「两边都没清」而失去判定力。
    const first = mountPool([makeCandidate({ part_serial_no: 'SN-0001' })]);
    await first.find('.el-input-stub__input').setValue('SN-0001');
    const second = mountPool(
      [makeCandidate({ part_serial_no: 'SN-0002' })],
      new Set(),
      '2000000000999',
    );
    await second.find('.el-input-stub__input').setValue('SN-0002');

    await second.find('.el-input-stub__input').trigger('keyup', { key: 'Enter' });
    await nextTick();

    expect((first.find('.el-input-stub__input').element as HTMLInputElement).value).toBe('SN-0001');
    expect((second.find('.el-input-stub__input').element as HTMLInputElement).value).toBe('');
    first.unmount();
    second.unmount();
  });
});

/** 模拟扫码枪：逐字符按键（间隔 < 30ms 判为「快速连击」）、以 Enter 结束 ——
 *  与 `useBarcodeScanner` 的判据一致。监听器挂在 window 上（模块级单例），所以事件必须
 *  dispatch 到 window 而不是 document。 */
function fireScan(code: string): void {
  for (const ch of code) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ch }));
  }
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
}
