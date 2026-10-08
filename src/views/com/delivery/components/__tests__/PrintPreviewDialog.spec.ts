// @vitest-environment happy-dom
// src/views/com/delivery/components/__tests__/PrintPreviewDialog.spec.ts
//
// 打印送货单对话框的守卫。覆盖：
//   - 模板未上传 → 「导出」disabled（tooltip 说明原因）；
//   - 模板校验失败（逐条差异）→ 「导出」disabled + 差异原文上屏；
//   - 模板校验通过 → 「导出」可点（哪怕还没选司机 —— 单据上已有司机名即可）；
//   - 未指定司机 → 「导出」disabled（页脚「送货人」与 pickup 都要它）；
//   - el-tabs 按 L2 客户分组，label 带 (N)；
//   - 行拆分（守恒不通过则「确定」disabled）；
//   - 司机落库时机：没碰下拉直接导出 ⇒ 零 driver POST（打开时的零 POST 另有用例）。
//
// 2026-10-09：「打印标签」不再经本对话框（`mode` prop 与标签模式的模板区 / 司机下拉 /
// 勾选集合整体下线，改由 `utils/deliveryNoteLabelExport` 直出，见它的用法与
// `deliveryNotePartRows.spec.ts`），所以本文件不再有标签模式的用例。
//
// ⚠️ 两条「导出」闸门用例守的是**对话框内**的闸门，与入口可见性无关：详情页 / 草稿卡
// 的按钮一律可见（canPrint 只看角色 + 行项数），司机由对话框自己兜。这是 2026-10-08
// 死锁修复后必须仍然成立的不变量。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, type PropType } from 'vue';
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { readFileSync } from 'node:fs';
import type * as HttpModule from '@/api/http';

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn<(url: string, config?: unknown) => Promise<{ data: unknown }>>(async () => ({
    data: { items: [] },
  })),
  apiPostMock: vi.fn<(url: string, body?: unknown) => Promise<{ data: unknown }>>(async () => ({
    data: null,
  })),
}));

vi.mock('@/api/http', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpModule>();
  return { ...actual, api: { ...actual.api, get: apiGetMock, post: apiPostMock } };
});

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElMessageBox: { confirm: vi.fn() },
}));

/** 下载桩：happy-dom 没有真实下载，送货单的导出产物靠它断言文件名。 */
const downloads: { filename: string; blob: Blob }[] = [];
vi.mock('@/utils/download', () => ({
  triggerBrowserDownload: (blob: Blob, filename: string) => {
    downloads.push({ filename, blob });
  },
}));

const app = createApp({ render: () => null });
app.use(createPinia());
app.use(VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) });
setActivePinia(app.config.globalProperties.$pinia);

// 「已打印标签」是模块级单例（跨用例累积），每个用例前清空 —— localStorage.clear() 只清盘，
// 清不掉内存里的 `_store`。
const { ElMessage } = await import('element-plus');

const BUILTIN = readFileSync('templates/delivery_note_fala.xlsx');

function li(p: Record<string, unknown> = {}) {
  return {
    id: '1',
    part_id: 'P1',
    batch_no: 1,
    batch_label: 'L1',
    serial_no: 'S-1',
    drawing_no: 'D-1',
    name: '铝电解电容',
    quantity: 5,
    status: 'READY_TO_SHIP',
    applicant_name: '张三',
    request_date: null,
    planned_delivery_date: null,
    system_delivery_date: '2026-11-01',
    order_no: 'SO-1',
    note: null,
    customer_name: '法拉',
    parent_customer_name: '法拉电子',
    customer_path: '法拉电子 / 法拉',
    assembly_id: null,
    assembly_serial_no: null,
    assembly_drawing_no: null,
    assembly_name: null,
    assembly_order_no: null,
    ...p,
  };
}

function note(over: Record<string, unknown> = {}) {
  return {
    id: 'N1',
    version: 3,
    delivery_note_no: 'DN-001',
    customer_id: 'C1',
    customer_name: '法拉电子',
    customer_path: '法拉电子 / 法拉',
    status: 'DRAFT',
    submitted_at: null,
    picked_up_at: null,
    driver_worker_name: '李四',
    part_count: 1,
    note: null,
    delivery_date: null,
    line_items: [li()],
    ...over,
  };
}

/** EP 组件一律走 global.stubs（vitest 不挂 unplugin-vue-components，kebab 标签不会被
 * 自动 import 成具名组件）；列可见性 / 图标等重组件直接桩掉。 */
// ⚠️ EP 的 `:on-change` 是**函数 prop**不是 emit ⇒ 桩必须把它声明成 prop，
// 用例通过 props('onChange')(file) 驱动（$emit 不会触发 prop 回调）。
const ElUploadStub = defineComponent({
  name: 'ElUploadStub',
  props: { onChange: { type: Function as PropType<(f: unknown) => void>, default: undefined } },
  template: '<div class="mock-el-upload"><slot /></div>',
});

const stubs = {
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue', 'title'],
    template: '<div class="mock-el-dialog"><slot /><slot name="footer" /></div>',
  },
  'el-button': {
    name: 'ElButtonStub',
    props: ['type', 'size', 'disabled', 'loading'],
    emits: ['click'],
    template:
      '<button class="mock-el-button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  'el-tag': { name: 'ElTagStub', template: '<span class="mock-el-tag"><slot /></span>' },
  'el-tooltip': {
    name: 'ElTooltipStub',
    props: ['content', 'disabled', 'placement'],
    template: '<span class="mock-el-tooltip" :title="content"><slot /></span>',
  },
  'el-upload': ElUploadStub,
  'el-select': {
    name: 'ElSelectStub',
    props: ['modelValue', 'loading', 'disabled'],
    // v-model 编译成 modelValue + onUpdate:modelValue 两个 prop；桩 emit 前者即可驱动下拉。
    // change 也要能 emit：真实 el-select 在更新 modelValue 之后还会发 change，
    // 「切换下拉不 POST」这条不变量必须连 change 路径一起钉住。
    emits: ['update:modelValue', 'change'],
    template: '<div class="mock-el-select"><slot /></div>',
  },
  'el-option': { name: 'ElOptionStub', template: '<div><slot /></div>' },
  'el-radio-group': { name: 'ElRadioGroupStub', props: ['modelValue'], template: '<div><slot /></div>' },
  'el-radio-button': { name: 'ElRadioButtonStub', props: ['value'], template: '<span><slot /></span>' },
  'el-tabs': {
    name: 'ElTabsStub',
    props: ['modelValue'],
    template: '<div class="mock-el-tabs"><slot /></div>',
  },
  'el-tab-pane': {
    name: 'ElTabPaneStub',
    props: ['name'],
    template: '<div class="mock-el-tab-pane" :data-name="name"><slot name="label" /><slot /></div>',
  },
  'el-table': defineComponent({
    name: 'ElTableStub',
    props: { data: { type: Array as PropType<unknown[]>, default: () => [] } },
    setup: (props, { slots }) => () =>
      h(
        'div',
        { class: 'mock-el-table', 'data-rows': (props.data || []).length },
        slots.default?.(),
      ),
  }),
  'el-table-column': defineComponent({
    name: 'ElTableColumnStub',
    props: ['label', 'columnKey'],
    setup: (p) => () =>
      h('div', { class: 'mock-el-table-column', 'data-label': p.label }),
  }),
  'el-input-number': { name: 'ElInputNumberStub', template: '<input class="mock-el-input-number" />' },
  ColumnVisibilityPopover: true,
  ElIcon: true,
  ElTable: true,
};

async function mountDialog(over: Record<string, unknown> = {}): Promise<VueWrapper> {
  const { default: Dialog } = await import('../PrintPreviewDialog.vue');
  const w = app.runWithContext(() =>
    mount(Dialog, {
      props: { modelValue: true, note: note(over) },
      global: { stubs },
    }),
  );
  await flush();
  return w;
}

/** 模板上传链是 async（arrayBuffer + 动态 import hucre + openXlsx/saveXlsx）⇒ 这里的
 *  flush 要跨若干个宏任务，不能只 flush 微任务。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** 导出按钮的 disabled 态。 */
function exportDisabled(w: VueWrapper): boolean {
  return w.find('button[data-role="export"]').attributes('disabled') !== undefined;
}

/** 走一遍 el-upload 的 on-change（桩声明成 prop，直接调函数 prop）。
 *
 *  onChange 是 async（arrayBuffer + 动态 import hucre + openXlsx）⇒ **await 它返回的
 *  Promise**，只靠 flush 微任务在整仓并发跑时会偶发来不及。 */
async function uploadFile(w: VueWrapper, file: { raw: File; name: string }): Promise<void> {
  const onChange = w.findComponent(ElUploadStub).props('onChange');
  await onChange?.(file);
  await flush();
}

/** 由内置模板造一个 File（el-upload 给的是 raw File，对话框自己 arrayBuffer 成 bytes）。
 *
 *  ⚠️ 必须从 Buffer 重新构造一个**精确长度**的 ArrayBuffer：直接用 `BUILTIN.buffer`
 *  会拿到 node 8MB 池化缓冲的整段（字节里混着别的数据，hucre 解 zip 直接报错）。 */
function builtinFile(name = 'delivery_note_fala.xlsx'): { raw: File; name: string } {
  const exact = new Uint8Array(BUILTIN.byteLength);
  exact.set(BUILTIN);
  return { raw: new File([exact.buffer as ArrayBuffer], name), name };
}

/** 由内置模板造一个改坏 C3（列位错位）的 File：用 hucre 改一格再序列化，
 *  走的是与真实上传完全相同的 round-trip 路径，产出的字节是真 xlsx。 */
async function brokenTemplateFile(): Promise<{ raw: File; name: string }> {
  const { openXlsx, saveXlsx } = await import('hucre');
  const wb = await openXlsx(new Uint8Array(BUILTIN));
  wb.sheets[0]!.rows[2]![2] = '{{L2_customer}}';
  const bytes = await saveXlsx(wb);
  const exact = new Uint8Array(bytes.byteLength);
  exact.set(bytes);
  return { raw: new File([exact.buffer as ArrayBuffer], 'broken.xlsx'), name: 'broken.xlsx' };
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockResolvedValue({ data: { items: [] } });
  apiPostMock.mockReset();
  apiPostMock.mockResolvedValue({ data: null });
  downloads.length = 0;
  localStorage.clear();
  (ElMessage.error as unknown as { mock: { calls: unknown[] } }).mock.calls.length = 0;
});

describe('PrintPreviewDialog 导出闸门', () => {
  it('没传模板 → 「导出」disabled，tooltip 说明「请先上传送货单模板」', async () => {
    const w = await mountDialog();
    expect(exportDisabled(w)).toBe(true);
    expect(w.find('.mock-el-tooltip').attributes('title')).toContain('请先上传送货单模板');
  });

  it('模板通过 + 单据上已有司机 → 「导出」可点', async () => {
    const w = await mountDialog();
    await uploadFile(w, builtinFile());
    expect(w.text()).toContain('已校验');
    expect(exportDisabled(w)).toBe(false);
  });

  it('模板通过但未指定司机 → 「导出」disabled（页脚「送货人」与 pickup 都要它）', async () => {
    const w = await mountDialog({ driver_worker_name: null });
    await uploadFile(w, builtinFile());
    expect(exportDisabled(w)).toBe(true);
    expect(w.find('.mock-el-tooltip').attributes('title')).toContain('请先指定司机');
  });

  it('模板校验失败 → 差异上屏 + 「导出」保持 disabled', async () => {
    const w = await mountDialog();
    await uploadFile(w, await brokenTemplateFile());
    expect(w.text()).toContain('C3 期望 {{l2_customer}}');
    expect(w.text()).toContain('{{L2_customer}}');
    expect(exportDisabled(w)).toBe(true);
  });

  it('阻断原因有优先级：模板 > 行项 > 司机（都缺时先说模板）', async () => {
    const w = await mountDialog({ driver_worker_name: null, line_items: [] });
    expect(w.find('.mock-el-tooltip').attributes('title')).toBe('请先上传送货单模板');
  });

  it('有行项时页脚显示条数与 sheet 数', async () => {
    const w = await mountDialog();
    expect(w.text()).toContain('共 1 条');
    expect(w.text()).toContain('1 个 sheet');
  });
});

describe('PrintPreviewDialog 分组 tabs', () => {
  it('按 L2 客户分组，tab label 带组名与 (N)', async () => {
    const w = await mountDialog({
      line_items: [
        li({ id: '1', part_id: 'P1', customer_name: '二五六厂' }),
        li({ id: '2', part_id: 'P2', customer_name: '陆达电子' }),
        li({ id: '3', part_id: 'P3', customer_name: '陆达电子' }),
      ],
    });
    const labels = w.findAll('.tab-label__code').map((e) => e.text());
    expect(labels).toEqual(['二五六厂', '陆达电子']);
    expect(w.findAll('.tab-label__count').map((e) => e.text())).toEqual(['(1)', '(2)']);
  });

  it('tab 顺序 = 分组键在 line_items 中首次出现的顺序', async () => {
    const w = await mountDialog({
      line_items: [
        li({ id: '1', part_id: 'P1', customer_name: '陆达电子' }),
        li({ id: '2', part_id: 'P2', customer_name: '二五六厂' }),
      ],
    });
    expect(w.findAll('.tab-label__code').map((e) => e.text())).toEqual(['陆达电子', '二五六厂']);
  });

  it('单上有装配件子件才显示「合并一套 / 分开打子件」radio', async () => {
    const loose = await mountDialog();
    expect(loose.text()).not.toContain('合并一套');
    const asm = await mountDialog({
      line_items: [
        li({ id: '1', part_id: 'PA', assembly_id: 'A1', assembly_name: '总装', shippable_sets: 3 }),
        li({ id: '2', part_id: 'PB', assembly_id: 'A1', assembly_name: '总装', shippable_sets: 3 }),
      ],
    });
    expect(asm.text()).toContain('合并一套');
    expect(asm.text()).toContain('分开打子件');
  });

  it('分组查询走 /com/delivery/group（打印时才知道有没有分组规则）', async () => {
    await mountDialog();
    const groupCall = apiGetMock.mock.calls.find((c) => String(c[0]).includes('/delivery/group'));
    expect(groupCall?.[0]).toBe('/com/delivery/group');
  });
});

describe('PrintSplitEditor 数量守恒', () => {
  it('原行数量未知（装配件「后端没给可出货套数」）→ 「确定」disabled + 说清原因', async () => {
    const { default: Editor } = await import('../PrintSplitEditor.vue');
    const ed = mount(Editor, {
      props: {
        row: {
          id: 'ASM_A1',
          order_no: 'SO-1',
          l2_customer: '法拉',
          applicant_name: '张三',
          drawing_no: 'D-1',
          name: '总装',
          quantity: null,
          unit: '套',
          system_delivery_date: null,
          note: '',
          is_asm_row: true,
        },
      },
      global: { stubs },
    });
    const confirmBtn = ed.findAll('button.mock-el-button').at(-1)!;
    expect(confirmBtn.attributes('disabled')).toBeDefined();
    expect(ed.text()).toContain('原行数量未知，无法拆分');
    await confirmBtn.trigger('click');
    await flush();
    expect(ed.emitted('done')).toBeUndefined();
  });

  it('Σ === 原数量 → 「确定」可点并 emit 拆出的行', async () => {
    const { default: Editor } = await import('../PrintSplitEditor.vue');
    const ed = mount(Editor, {
      props: {
        row: {
          id: '1',
          order_no: 'SO-1',
          l2_customer: '法拉',
          applicant_name: '张三',
          drawing_no: 'D-1',
          name: '电容',
          quantity: 5,
          unit: '',
          system_delivery_date: null,
          note: '原备注',
        },
      },
      global: { stubs },
    });
    const confirmBtn = ed.findAll('button.mock-el-button').at(-1)!;
    expect(confirmBtn.attributes('disabled')).toBeUndefined();
    await confirmBtn.trigger('click');
    // splitRow 是动态 import 的纯函数，确认后一拍才 emit
    await flush();
    expect(ed.emitted('done')).toBeTruthy();
  });
});

describe('模板契约常量', () => {
  it('内置模板存在（对话框的「上传」默认值参考它）', () => {
    expect(BUILTIN.byteLength).toBeGreaterThan(0);
  });
});

// ============================================================
// 司机绑定时机（2026-10-08 死锁修复的核心验收点）
// ============================================================

/** 让 GET /com/delivery/drivers 返回两名候选（否则下拉选中项查不到名字）。 */
function withDriverOptions(): void {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url.includes('/drivers')) {
      return {
        data: {
          items: [
            { id: 'W1', name: '李四', badge_code: 'S001' },
            { id: 'W2', name: '王五', badge_code: 'S002' },
          ],
        },
      };
    }
    return { data: { items: [] } };
  });
}

/** 等某个条件成立。桩 GET 与 hucre 渲染都是异步链，机器忙时固定轮次的 `flush` 不够
 *  （整套 spec 与其它文件并行跑时尤其明显）—— 断言前先轮询到终态，别赌 sleep 够长。 */
async function waitUntil(ok: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (ok()) return;
    await nextTick();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等待超时：${label}`);
}

/** 错误 toast 次数（对话框里所有失败路径都先 ElMessage.error 再 return）。 */
function errorToastCount(): number {
  return (ElMessage.error as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
}

/** 在司机下拉里选中 id（走 v-model，与用户点选同一条路径）。 */
async function selectDriver(w: VueWrapper, id: string): Promise<void> {
  // 等司机候选回流：选中项要能在候选列表里查到名字，否则落库闸门不会触发。
  await waitUntil(() => w.findAllComponents({ name: 'ElOptionStub' }).length === 2, '司机候选回流');
  const sel = w.findComponent({ name: 'ElSelectStub' });
  sel.vm.$emit('update:modelValue', id);
  sel.vm.$emit('change', id); // 真实 el-select 的事件序列：先更值，再发 change
  await flush();
}

/** 点「导出」并等导出流程落定：`expectFile` = 等产物落地，否则等错误 toast（= 中止）。 */
async function clickExport(w: VueWrapper, expectFile: boolean): Promise<void> {
  const before = errorToastCount();
  await w.find('button[data-role="export"]').trigger('click');
  if (expectFile) {
    await waitUntil(() => downloads.length === 1, '导出产物落地');
  } else {
    await waitUntil(() => errorToastCount() > before, '导出中止（错误 toast）');
  }
  await flush();
}

/** 打过 `/{id}/driver` 的 POST 调用。 */
function driverPosts(): unknown[][] {
  return apiPostMock.mock.calls.filter((c) => String(c[0]).includes('/driver'));
}

describe('PrintPreviewDialog 司机绑定时机', () => {
  it('打开对话框（还没选司机）→ 零 POST', async () => {
    withDriverOptions();
    await mountDialog({ driver_worker_name: null });
    expect(driverPosts()).toHaveLength(0);
  });

  it('在下拉里选司机 → 仍零 POST（切换只写本地态）', async () => {
    withDriverOptions();
    const w = await mountDialog({ driver_worker_name: null });
    await uploadFile(w, builtinFile());
    await selectDriver(w, 'W2');
    expect(driverPosts()).toHaveLength(0);
    // 选完之后「导出」可点（司机闸门在对话框内被满足）
    expect(exportDisabled(w)).toBe(false);
  });

  it('点「导出」→ 先 POST /{id}/driver 成功，再下载 xlsx', async () => {
    withDriverOptions();
    const w = await mountDialog({ driver_worker_name: null });
    await uploadFile(w, builtinFile());
    await selectDriver(w, 'W2');
    await clickExport(w, true);
    expect(driverPosts()).toHaveLength(1);
    expect(driverPosts()[0]![0]).toBe('/com/delivery/note/N1/driver');
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.filename).toBe('DN-001.xlsx');
  });

  it('单据上已有司机名 + 不碰下拉 → 导出时零 driver POST，xlsx 照常下载', async () => {
    // 裁决 J 落库判据（`driverId` 非空才 POST）的端到端一侧：没碰下拉 ⇒ 零 POST。
    // 打开时的零 POST 由上面那条守着，这条守的是**导出那一刻**。
    withDriverOptions();
    const w = await mountDialog(); // note() 默认 driver_worker_name = '李四'
    await uploadFile(w, builtinFile());
    await clickExport(w, true);
    expect(driverPosts()).toHaveLength(0);
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.filename).toBe('DN-001.xlsx');
  });

  it('选了与单据上**同名但不同 id** 的司机 → 也要 POST（司机名允许重名，按名短路会让单据仍绑旧 id）', async () => {
    withDriverOptions();
    const w = await mountDialog({ driver_worker_name: '李四' });
    await uploadFile(w, builtinFile());
    await selectDriver(w, 'W1'); // W1 才是「李四」，单据上那个同名司机是别人
    await clickExport(w, true);
    expect(driverPosts()).toHaveLength(1);
    expect(driverPosts()[0]![1]).toEqual({ version: 3, driver_worker_id: 'W1' });
    expect(downloads).toHaveLength(1);
  });

  it('关对话框再打开 → 下拉复位（没落库的司机不该被「本单已指定」之外的幽灵选中项顶住）', async () => {
    withDriverOptions();
    const w = await mountDialog({ driver_worker_name: null });
    await uploadFile(w, builtinFile());
    await selectDriver(w, 'W2');
    expect(w.findComponent({ name: 'ElSelectStub' }).props('modelValue')).toBe('W2');

    await w.setProps({ modelValue: false });
    await flush();
    await w.setProps({ modelValue: true });
    await flush();

    // 详情页的 v-if 只判 detail.note，组件不卸载 ⇒ 复位只能靠打开沿的 watch
    expect(w.findComponent({ name: 'ElSelectStub' }).props('modelValue')).toBe('');
    expect(driverPosts()).toHaveLength(0);
  });

  it('司机落库失败 → 中止导出、不产出文件', async () => {
    withDriverOptions();
    // 按 URL 条件拒绝（而不是 mockRejectedValueOnce）：对话框里 POST 的先后顺序不保证，
    // 一旦有别的 POST 抢先消费掉 once，失败路径就测不到了。
    apiPostMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/driver')) throw new Error('版本已过期，请刷新');
      return { data: null };
    });
    const w = await mountDialog({ driver_worker_name: null });
    await uploadFile(w, builtinFile());
    await selectDriver(w, 'W2');
    await clickExport(w, false);
    expect(driverPosts()).toHaveLength(1);
    expect(downloads).toHaveLength(0);
    // 按钮回到可点（用户改了条件还能重试），对话框仍开着
    expect(w.find('button[data-role="export"]').attributes('disabled')).toBeUndefined();
    expect(w.emitted('update:modelValue')).toBeUndefined();
  });

  it('关对话框（取消）→ 零 POST：司机改动留在本地，服务端没有副作用', async () => {
    withDriverOptions();
    const w = await mountDialog({ driver_worker_name: null });
    await uploadFile(w, builtinFile());
    await selectDriver(w, 'W2');
    await w.findAll('button.mock-el-button').find((b) => b.text().includes('取消'))!.trigger('click');
    await flush();
    expect(driverPosts()).toHaveLength(0);
    expect(downloads).toHaveLength(0);
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([false]);
  });
});
