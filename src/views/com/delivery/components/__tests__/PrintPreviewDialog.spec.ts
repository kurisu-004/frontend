// @vitest-environment happy-dom
// src/views/com/delivery/components/__tests__/PrintPreviewDialog.spec.ts
//
// 打印送货单对话框的守卫。覆盖：
//   - 该一级客户没绑模板（21109）→ 「导出」disabled，提示指向「模板编辑」页；
//   - 绑的是零件版 / 检具版 ⇒ 探测出版式、按版式取 sheet 容量（10 / 25）、按版式构造页脚、
//     司机下拉**只对零件版**渲染；
//   - 判不出版式（四个锚点都不中）⇒ 「导出」disabled + 一句提示，**且不列逐格差异**
//     （逐格校验是「模板编辑」页上传闸的职责，见 PrintPreviewDialog.vue 文件头）；
//   - **单据上没有司机也照样能导出**（指定司机搬去「一键送货」那一步）；
//   - el-tabs 按收货单位分组，label 带 (N)；
//   - 行拆分（守恒不通过则「确定」disabled）；
//   - 司机落库时机：没碰下拉直接导出 ⇒ 零 driver POST（打开时的零 POST 另有用例）。
//
// ⚠️ **模板的搭台方式只有一种**：`resolve` 端点命中 + `/{id}/content` 返磁盘上那份示例模板的
// 字节。打印页没有上传入口（产品决策 2026-10-18），所以「先在对话框里选个文件」这条搭台路径
// 根本不存在 —— 用例改 mock 那两个端点是在走**唯一真实**的那条链路。
//
// ⚠️ 两条「导出」闸门用例守的是**对话框内**的闸门，与入口可见性无关：详情页 / 草稿卡
// 的按钮一律可见（canPrint 只看权限点 `delivery_note.print` + 行项数，司机已不参与）。
// 指定司机**不由本对话框兜底** —— 那是「一键送货」确认对话框（`DeliveryDriverPickerDialog`）
// 的职责，见该组件的 spec。

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

/** 下载桩：happy-dom 没有真实下载，送货单的导出产物靠它断言文件名与字节内容。 */
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

const { ElMessage } = await import('element-plus');

/** 仓库里的两份示例模板（真实字节）。用例一律拿它们当被测输入，不造假的结构。 */
const BUILTIN_PART = readFileSync('templates/delivery_note_fala.xlsx');
const BUILTIN_GAUGE = readFileSync('templates/delivery_note_gauge_bailuda.xlsx');

/**
 * 精确长度的 ArrayBuffer（**不能用 `buf.buffer`**：那是 node 8MB 池化缓冲的整段，字节里混着
 * 别的数据，hucre 解 zip 直接报错）。
 */
function exactBuffer(src: Uint8Array): ArrayBuffer {
  const exact = new Uint8Array(src.byteLength);
  exact.set(src);
  return exact.buffer as ArrayBuffer;
}

/** 手动可控的 Promise 闸：resolve 竞态用例用它卡住某一次请求。 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** resolve 命中时那一行（后端 `PrintTemplateOut` 12 字段）。 */
const BOUND_TEMPLATE_ROW = {
  id: 'T1',
  customer_id: 'C1',
  kind: 'DELIVERY_TEMPLATE',
  file_type: 'XLSX',
  original_filename: 'fala_bound.xlsx',
  file_size: 0,
  content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  content_sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  version: 2,
  created_at: '2026-10-16 09:00:00',
  updated_at: '2026-10-16 09:00:00',
  customer_name: '法拉电子',
};

/**
 * `GET /print-templates/resolve` 命中的出参（后端 `PrintTemplateResolveOut` 逐字形状）。
 *
 * ⚠️ **出参是嵌套的**（一个信封套一行），平铺形状是本域第 1 轮踩过的坑：后端真给的顶层只有
 * `customer_name`（另一条 `t_customer` 查询的结果）。**也没有 `content_url`** —— 后端从头到尾
 * 没有这个字段，取字节只有 `/{id}/content` 这条带鉴权的 axios 端点。
 */
function boundTemplateOut(fileSize: number, filename = 'fala_bound.xlsx') {
  return {
    template: { ...BOUND_TEMPLATE_ROW, file_size: fileSize, original_filename: filename },
    customer_name: '法拉电子',
  };
}

/**
 * 该一级客户当前绑定的模板字节（`null` = 未绑定 ⇒ `resolve` 抛业务码 21109，绝大多数客户
 * 就是这个状态）。做成**变量**而不是「换一个 mockImplementation」—— 后者会让各用例的桩互相
 * 覆盖（`withDriverOptions` 就是那种写法），一旦顺序变了一处就静默失效。
 */
let boundBytes: Uint8Array | null = null;
let boundFilename = 'fala_bound.xlsx';

/** 让该一级客户绑上 `src` 那份模板（下次 `mountDialog` 的自动选用就会取它）。 */
function bindTemplate(src: Uint8Array, filename = 'fala_bound.xlsx'): void {
  boundBytes = src;
  boundFilename = filename;
}

/** GET 的默认实现：送货车用端点返空、resolve 按「绑没绑」分流、content 返绑定的那份字节。 */
async function defaultGet(url: string): Promise<{ data: unknown }> {
  if (url.includes('/print-templates/resolve')) {
    if (!boundBytes) {
      // 未绑定 = **业务码 21109 的信封**（不是 HTTP 错误）：响应拦截器会把它抛成
      // ApiError(21109)，对话框据此提示去「模板编辑」页配模板。
      throw Object.assign(new Error('该一级客户未绑定打印模板'), { code: 21109 });
    }
    return { data: boundTemplateOut(boundBytes.byteLength, boundFilename) };
  }
  if (url.includes('/print-templates/T1/content')) return { data: exactBuffer(boundBytes!) };
  return { data: { items: [] } };
}

/** 判不出版式的字节：把探测用的四个锚点格（B3 / B5 / F15 / I2）全抹掉，走真实 round-trip。 */
async function unrecognizableTemplateBytes(): Promise<Uint8Array> {
  const { openXlsx, saveXlsx } = await import('hucre');
  const wb = await openXlsx(new Uint8Array(BUILTIN_PART));
  const sheet = wb.sheets[0]!;
  sheet.rows[2]![1] = '';
  sheet.rows[4]![1] = '';
  sheet.rows[14]![5] = '';
  sheet.rows[1]![8] = '';
  return await saveXlsx(wb);
}

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

/** n 条同一收货单位的行项（`part_id` 必须各不相同 —— `groupRows` 会按 part 折叠同件多批次）。 */
function items(n: number) {
  return Array.from({ length: n }, (_, i) =>
    li({ id: String(i + 1), part_id: `P${i + 1}`, drawing_no: `D-${i + 1}` }),
  );
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
 *  自动 import 成具名组件）；列可见性 / 图标等重组件直接桩掉。 */
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

/** 挂一个「该一级客户绑着 `src`」的单据，并等自动选用 + 版式探测落定。 */
async function mountWithBound(
  src: Uint8Array,
  over: Record<string, unknown> = {},
  filename = 'fala_bound.xlsx',
): Promise<VueWrapper> {
  bindTemplate(src, filename);
  const w = await mountDialog(over);
  await waitUntil(() => w.text().includes('该客户绑定模板'), '自动选用落定');
  return w;
}

/** 模板链路是 async（两次往返 + 动态 import hucre + xlsx 解析）⇒ 这里的 flush 要跨若干个
 *  宏任务，不能只 flush 微任务。 */
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

/** 打开第 n 份导出产物（断言检具版渲染结果时要看字节内容，不只是文件名）。 */
async function openDownloaded(n = 0) {
  const { openXlsx } = await import('hucre');
  const buf = await downloads[n]!.blob.arrayBuffer();
  return await openXlsx(new Uint8Array(buf));
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation(async (url: string) => defaultGet(url));
  apiPostMock.mockReset();
  apiPostMock.mockResolvedValue({ data: null });
  boundBytes = null;
  boundFilename = 'fala_bound.xlsx';
  downloads.length = 0;
  localStorage.clear();
  (ElMessage.error as unknown as { mock: { calls: unknown[] } }).mock.calls.length = 0;
});

describe('PrintPreviewDialog 导出闸门', () => {
  it('该客户未绑定模板（21109）→ 「导出」disabled，tooltip 说清去哪儿配模板', async () => {
    const w = await mountDialog();
    expect(exportDisabled(w)).toBe(true);
    // ⚠️ 提示必须指向「模板编辑」页，而不是让用户误以为每次打印都要现场传一份
    //（打印页**没有**上传入口了）。
    expect(w.find('.mock-el-tooltip').attributes('title')).toContain('未绑定打印模板');
    expect(w.find('.mock-el-tooltip').attributes('title')).toContain('模板编辑');
  });

  it('绑的是零件版模板 → 「导出」可点', async () => {
    const w = await mountWithBound(BUILTIN_PART);
    expect(w.text()).toContain('fala_bound.xlsx');
    expect(w.text()).toContain('零件版');
    expect(exportDisabled(w)).toBe(false);
  });

  it('模板可用但单据上没有司机 → 「导出」仍可点，提示里没有「请先指定司机」，且导出零 driver POST', async () => {
    // 指定司机改到「一键送货」的确认对话框里选（服务端 POST /{id}/pickup 只吃 version、
    // 司机从单据上读，没司机返 21409）。
    withDriverOptions();
    const w = await mountWithBound(BUILTIN_PART, { driver_worker_name: null });
    expect(exportDisabled(w)).toBe(false);
    expect(w.find('.mock-el-tooltip').attributes('title')).not.toContain('请先指定司机');
    await clickExport(w, true);
    expect(driverPosts()).toHaveLength(0);
    expect(downloads).toHaveLength(1);
  });

  it('阻断原因有优先级：模板 > 行项（司机已不参与阻断；都缺时先说模板）', async () => {
    const w = await mountDialog({ driver_worker_name: null, line_items: [] });
    expect(w.find('.mock-el-tooltip').attributes('title')).toContain('未绑定打印模板');
  });

  it('模板可用了但一行都没有 → 阻断原因只剩「没有可打印的行项」', async () => {
    const w = await mountWithBound(BUILTIN_PART, { driver_worker_name: null, line_items: [] });
    expect(exportDisabled(w)).toBe(true);
    expect(w.find('.mock-el-tooltip').attributes('title')).toBe('没有可打印的行项');
  });

  it('有行项时页脚显示条数与 sheet 数', async () => {
    const w = await mountDialog();
    expect(w.text()).toContain('共 1 条');
    expect(w.text()).toContain('1 个 sheet');
  });
});

describe('PrintPreviewDialog 分组 tabs', () => {
  it('按收货单位分组，tab label 带组名与 (N)', async () => {
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
  it('仓库里两份示例模板都在（用例拿它们的字节当真实输入）', () => {
    expect(BUILTIN_PART.byteLength).toBeGreaterThan(0);
    expect(BUILTIN_GAUGE.byteLength).toBeGreaterThan(0);
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
    return defaultGet(url);
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
    const w = await mountWithBound(BUILTIN_PART, { driver_worker_name: null });
    await selectDriver(w, 'W2');
    expect(driverPosts()).toHaveLength(0);
    // 「导出」只 gate 模板与行项，与司机无关（司机闸门早已摘掉）——选不选司机都可点，
    // 这条只顺带确认「选完不影响导出可用性」。
    expect(exportDisabled(w)).toBe(false);
  });

  it('点「导出」→ 先 POST /{id}/driver 成功，再下载 xlsx', async () => {
    withDriverOptions();
    const w = await mountWithBound(BUILTIN_PART, { driver_worker_name: null });
    await selectDriver(w, 'W2');
    await clickExport(w, true);
    expect(driverPosts()).toHaveLength(1);
    expect(driverPosts()[0]![0]).toBe('/com/delivery/note/N1/driver');
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.filename).toBe('DN-001.xlsx');
  });

  it('单据上已有司机名 + 不碰下拉 → 导出时零 driver POST，xlsx 照常下载', async () => {
    // 落库判据只有一条：`driverId` 非空（用户在下拉里选过）才 POST。没碰下拉 ⇒ 零 POST。
    // 打开时的零 POST 由上面那条守着，这条守的是**导出那一刻**。
    withDriverOptions();
    const w = await mountWithBound(BUILTIN_PART); // note() 默认 driver_worker_name = '李四'
    await clickExport(w, true);
    expect(driverPosts()).toHaveLength(0);
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.filename).toBe('DN-001.xlsx');
  });

  it('选了与单据上**同名但不同 id** 的司机 → 也要 POST（司机名允许重名，按名短路会让单据仍绑旧 id）', async () => {
    withDriverOptions();
    const w = await mountWithBound(BUILTIN_PART, { driver_worker_name: '李四' });
    await selectDriver(w, 'W1'); // W1 才是「李四」，单据上那个同名司机是别人
    await clickExport(w, true);
    expect(driverPosts()).toHaveLength(1);
    expect(driverPosts()[0]![1]).toEqual({ version: 3, driver_worker_id: 'W1' });
    expect(downloads).toHaveLength(1);
  });

  it('关对话框再打开 → 下拉复位（没落库的司机不该被「本单已指定」之外的幽灵选中项顶住）', async () => {
    withDriverOptions();
    const w = await mountWithBound(BUILTIN_PART, { driver_worker_name: null });
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
    const w = await mountWithBound(BUILTIN_PART, { driver_worker_name: null });
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
    const w = await mountWithBound(BUILTIN_PART, { driver_worker_name: null });
    await selectDriver(w, 'W2');
    await w.findAll('button.mock-el-button').find((b) => b.text().includes('取消'))!.trigger('click');
    await flush();
    expect(driverPosts()).toHaveLength(0);
    expect(downloads).toHaveLength(0);
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([false]);
  });
});

// ============================================================
// 一级客户绑定模板的自动选用 + 版式探测（2026-10-18）
// ============================================================
// 打开对话框时按 `note.customer_id` 调 `GET /print-templates/resolve`：命中即取字节并**探测
// 版式**（`detectTemplateContract`）；未绑定（业务码 21109）提示去「模板编辑」页。
//
// ⚠️ 守的是两条不能省的：
//   1. 命中后必须**取字节**再定版式，不能拿 resolve 的元信息就当模板可用 —— 用
//     `bound_template_bytes_are_probed`；
//   2. 判不出版式必须**禁用导出**且只给一句提示（逐格差异是「模板编辑」页上传闸的产物）。

describe('PrintPreviewDialog 自动选用一级客户绑定的模板', () => {
  it('命中 → 自动选中，零用户操作即可导出', async () => {
    withDriverOptions();
    const w = await mountWithBound(BUILTIN_PART); // note() 默认 driver_worker_name = '李四'
    expect(w.text()).toContain('fala_bound.xlsx');
    expect(w.text()).toContain('该客户绑定模板');
    expect(w.text()).toContain('零件版');
    expect(exportDisabled(w)).toBe(false);
    // 打开本身不该有任何写操作
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('命中后取字节走的是 `/print-templates/{id}/content`（带鉴权的 axios 端点）', async () => {
    withDriverOptions();
    bindTemplate(BUILTIN_PART);
    await mountDialog();
    await waitUntil(
      () => apiGetMock.mock.calls.some((c) => String(c[0]).includes('/print-templates/T1/content')),
      '取模板字节',
    );
    // resolve 打的是带 query 的 resolve 端点，customer_id 来自 note.customer_id（C1）
    const resolveCall = apiGetMock.mock.calls.find((c) => String(c[0]).includes('/resolve'));
    expect(resolveCall?.[0]).toBe('/print-templates/resolve');
    expect((resolveCall?.[1] as { params?: Record<string, unknown> })?.params).toEqual({
      customer_id: 'C1',
    });
  });

  // ⚠️ 故意喂**本域第 1 轮那个平铺形状**（真后端从来没返回过它）：它是「后端形状变了 /
  // schema 没跟上」最真实的替身，比随手编个缺字段的对象更有回归价值。
  it('resolve 出参形状不对（少字段）⇒ 提示上屏 + console.warn，绝不静默降级', async () => {
    // 那段现场表现是「一行 12px 黄色小字 + 零 toast + 零日志」—— 生产上完全不可发现。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      withDriverOptions();
      bindTemplate(BUILTIN_PART);
      apiGetMock.mockImplementation(async (url: string) => {
        if (url.includes('/print-templates/resolve')) {
          // 旧版的**平铺**形状：后端 `PrintTemplateResolveOut` 是嵌套的，顶层这些键不存在
          // ⇒ `printTemplateResolveSchema.parse` 抛 ⇒ 走 catch 的 else 分支。
          return {
            data: {
              id: 'T1',
              customer_id: 'C1',
              customer_name: '法拉电子',
              original_filename: 'fala_bound.xlsx',
              file_size: BUILTIN_PART.byteLength,
              content_sha256: null,
              version: 2,
              updated_at: '2026-10-16 09:00:00',
            },
          };
        }
        return defaultGet(url);
      });

      const w = await mountDialog();
      await waitUntil(() => w.find('.auto-hint').exists(), '自动选用失败的提示上屏');

      // ① 上屏（不是静默）：文案要说清「自动选用出问题」而不是「没配模板」。
      expect(w.find('.auto-hint').text()).toContain('自动选用该客户模板失败');
      // ② 进日志：零日志的话生产上无从查起。
      expect(warnSpy).toHaveBeenCalled();
      // ③ 不谎报成「已绑定」，导出仍然禁用。
      expect(w.text()).not.toContain('该客户绑定模板');
      expect(exportDisabled(w)).toBe(true);
      // ④ 不误标成「未绑定」（那是 21109 的形态，两者提示要让用户去不同的地方解决）。
      expect(w.text()).not.toContain('未绑定打印模板');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('bound_template_bytes_are_probed：判不出版式（四个锚点都不中）⇒ 导出禁用 + 一句提示 + 不列逐格差异', async () => {
    // ⚠️ **不列逐格差异**是这条的一半断言：逐格校验在「模板编辑」页上传闸里做过一次，打印页
    // 再列一遍只会把「判不出版式」讲成「某某格不对」，把用户引去改 Excel 单元格。
    const unknown = await unrecognizableTemplateBytes();
    bindTemplate(unknown);
    const w = await mountDialog();
    await waitUntil(() => w.find('.auto-hint').exists(), '判不出版式的提示上屏');

    expect(w.find('.auto-hint').text()).toContain('不匹配任何一套版式');
    // 提示要指向唯一能解决的地方（打印页没有上传入口了）。
    expect(w.find('.mock-el-tooltip').attributes('title')).toContain('模板编辑');
    expect(w.text()).not.toContain('该客户绑定模板');
    expect(exportDisabled(w)).toBe(true);
    // 逐格差异列表整体下线：既没有差异面板，也没有任何「期望…实际为…」文案。
    expect(w.find('.template-diffs').exists()).toBe(false);
    expect(w.text()).not.toContain('期望');
  });

  it('判得出版式但单格坏了 ⇒ 照样可导出（打印页只探测、不逐格校验）', async () => {
    // 反向守卫：上面那条守「判不出要挡住」，这条守「判得出就别多事」—— 把逐格校验加回打印页
    // 会让这条转红，而那正是产品决策要避免的失败形态（管理员改一格 ⇒ 整批单子打不出来）。
    const { openXlsx, saveXlsx } = await import('hucre');
    const wb = await openXlsx(new Uint8Array(BUILTIN_PART));
    wb.sheets[0]!.rows[2]![2] = '{{L2_customer}}'; // C3 列位错位（上传闸会拒收它）
    const w = await mountWithBound(await saveXlsx(wb));
    expect(w.text()).toContain('零件版');
    expect(exportDisabled(w)).toBe(false);
    await clickExport(w, true);
    expect(downloads).toHaveLength(1);
  });

  // 常驻挂载下 resolve 在途期间 tooltip 必须说「正在自动选用」，不是「判不出版式」。
  it('resolve 在途期间 tooltip 是「正在自动选用…」，不是判不出版式那句', async () => {
    // 那段窗口 = 2 次往返 + 一次完整 xlsx 解析，是每次打开都必然经过的常态。三条失败分支都
    // 不命中时，tooltip 不能落到「判不出版式」—— 那会把常态说成故障。
    const gate = deferred();
    bindTemplate(BUILTIN_PART);
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.includes('/print-templates/resolve')) await gate.promise;
      return defaultGet(url);
    });
    const w = await mountDialog();
    await waitUntil(
      () => apiGetMock.mock.calls.some((c) => String(c[0]).includes('/print-templates/resolve')),
      'resolve 已发出',
    );
    expect(w.find('.mock-el-tooltip').attributes('title')).toContain('正在自动选用');

    gate.resolve();
    await waitUntil(() => w.text().includes('该客户绑定模板'), '自动选用落定');
    expect(w.find('.mock-el-tooltip').attributes('title')).not.toContain('正在自动选用');
  });

  it('关对话框再打开 ⇒ 重新按当下的绑定自动选用一次', async () => {
    withDriverOptions();
    const w = await mountWithBound(BUILTIN_PART);
    await w.setProps({ modelValue: false });
    await flush();
    apiGetMock.mockClear();
    await w.setProps({ modelValue: true });
    await flush();

    // 模板只来自后端绑定，每次打开都重新取（管理员在这期间换绑 / 删除都在下一次生效）。
    expect(
      apiGetMock.mock.calls.filter((c) => String(c[0]).includes('/print-templates/resolve')),
    ).toHaveLength(1);
    expect(w.text()).toContain('零件版');
  });

  // 换单必须清模板态：详情页可以在对话框**关着**的时候换单（v-if 前后都为真、组件不卸载、
  // modelValue 不变）⇒ 只看 modelValue 的 watch 一个字都不会触发。
  it('换一张送货单 ⇒ 模板不跟着飘（按新单据的一级客户重新 resolve）', async () => {
    withDriverOptions();
    const w = await mountWithBound(BUILTIN_PART);
    await w.setProps({ modelValue: false });
    await flush();
    // 对话框关着的时候换单：只有 note.id 与 customer_id 变了。
    await w.setProps({ note: note({ id: 'N2', customer_id: 'C2' }) });
    await flush();
    apiGetMock.mockClear();
    await w.setProps({ modelValue: true });
    await flush();

    await waitUntil(
      () =>
        apiGetMock.mock.calls.some(
          (c) =>
            String(c[0]).includes('/print-templates/resolve') &&
            (c[1] as { params?: Record<string, unknown> })?.params?.customer_id === 'C2',
        ),
      '按新单据的客户重新 resolve',
    );
    expect(w.text()).toContain('零件版');
  });

  // 代次守卫守的是「开→关→再开」时两次 resolve 并飞：#1 落地那一刻没有任何东西拦它。
  it('常驻挂载下「开→关→再开」，迟到的第一次 resolve 不得覆盖第二次的结果', async () => {
    withDriverOptions();
    bindTemplate(BUILTIN_PART);
    // 第一次 resolve 卡在闸上；第二次放行且返回**另一个**文件名，便于区分谁落地了。
    const firstGate = deferred();
    let resolveCalls = 0;
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.includes('/print-templates/resolve')) {
        // ⚠️ 序号必须**就地捕获**：第一次 resolve 卡在闸上期间计数器已经涨到 2，在 await 之后
        // 再读它会让两次都返回「第二个」的名字，用例就变成恒绿。
        const n = (resolveCalls += 1);
        if (n === 1) await firstGate.promise;
        return { data: boundTemplateOut(BUILTIN_PART.byteLength, n === 1 ? 'slow_first.xlsx' : 'fast_second.xlsx') };
      }
      return defaultGet(url);
    });

    const w = await mountDialog();
    await waitUntil(() => resolveCalls === 1, '第一次 resolve 已发出');
    await w.setProps({ modelValue: false });
    await flush();
    await w.setProps({ modelValue: true });
    await waitUntil(() => resolveCalls === 2, '第二次 resolve 已发出');
    // 第二次先落地（慢的那条仍卡在闸上）。
    await waitUntil(() => w.text().includes('fast_second.xlsx'), '第二次选用落定');
    expect(w.text()).toContain('该客户绑定模板');

    // 现在放行迟到的那条：没有代次守卫时它会把上面那个结果覆盖掉。
    firstGate.resolve();
    await waitUntil(
      () => apiGetMock.mock.calls.filter((c) => String(c[0]).includes('/print-templates/T1/content')).length >= 2,
      '迟到的第一次 resolve 取字节',
    );
    await flush();
    expect(w.text()).toContain('fast_second.xlsx');
    expect(w.text()).not.toContain('slow_first.xlsx');
  });
});

// ============================================================
// 检具版：按探测到的版式渲染（sheet 容量 / 页脚 / 司机下拉）
// ============================================================
describe('PrintPreviewDialog 检具版模板', () => {
  it('26 条 → 按检具版契约拆成 2 个 sheet、容量 25、C 列写客户路径、I2 是中文日期', async () => {
    // 这条同时钉住三件事：sheet 容量按**探测到的版式**取（写死零件版的 10 会拆成 3 张）、
    // 检具版 C 列写的是客户路径（不是叶子单段名）、页脚那个 `{{delivery_date}}` 被填成
    // `YYYY年M月D日`（不是零件版的年月日三段 —— 检具版模板里根本没有那三段）。
    const w = await mountWithBound(BUILTIN_GAUGE, { line_items: items(26) }, 'gauge_bailuda.xlsx');
    expect(w.text()).toContain('检具版');
    expect(w.text()).toContain('gauge_bailuda.xlsx');
    expect(w.text()).toContain('容量 25/张');
    expect(w.text()).toContain('共 26 条 · 2 个 sheet');

    await clickExport(w, true);
    const wb = await openDownloaded();
    expect(wb.sheets).toHaveLength(2);
    // 第 1 张 sheet 的数据区首行（0-based row 4 = Excel row 5）：A 序号 / B 订单号 /
    // C 客户路径（第 2 层到叶子、不含 L1）/ D 图号 / E 名称 / F 数量 / G·H 手写列留白 / I 交期
    expect(wb.sheets[0]!.rows[4]![2]).toBe('法拉电子 / 法拉');
    expect(wb.sheets[0]!.rows[4]![3]).toBe('D-1');
    expect(wb.sheets[0]!.rows[4]![5]).toBe(5);
    // 容量 25 ⇒ 第 25 条仍落在第 1 张（0-based row 28），第 26 条另起一张、序号从 1 重排
    expect(wb.sheets[0]!.rows[28]![0]).toBe(25);
    expect(wb.sheets[1]!.rows[4]![0]).toBe(1);
    expect(wb.sheets[1]!.rows[4]![3]).toBe('D-26');
    // I2 = 导出当天的中文日期（填的是整段，不是零件版的年 / 月 / 日三段）
    expect(String(wb.sheets[0]!.rows[1]![8])).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日$/);
  });

  it('检具版不渲染司机下拉（模板页脚没有「送货人」格）；零件版仍然渲染', async () => {
    // 反向守卫：`v-if` 写反会让检具送货单带着一个选了也没落点的司机下拉，而零件版那半
    // （真的能写进页脚）反倒没了 —— 两条一起断言才防得住。
    const gauge = await mountWithBound(BUILTIN_GAUGE, {}, 'gauge_bailuda.xlsx');
    expect(gauge.findComponent({ name: 'ElSelectStub' }).exists()).toBe(false);
    // 检具版导出不落 driver POST（下拉都没有，无从选起）
    await clickExport(gauge, true);
    expect(driverPosts()).toHaveLength(0);

    const part = await mountWithBound(BUILTIN_PART);
    expect(part.findComponent({ name: 'ElSelectStub' }).exists()).toBe(true);
  });

  it('零件版仍按零件版契约渲染（10 行/张、页脚写司机与年月日）', async () => {
    // 与上面那条对照：同一批行项、同一份字节来源，只因探测到的版式不同，产物就完全不同。
    const w = await mountWithBound(BUILTIN_PART, { line_items: items(26) });
    expect(w.text()).toContain('零件版');
    expect(w.text()).toContain('容量 10/张');
    expect(w.text()).toContain('共 26 条 · 3 个 sheet');

    await clickExport(w, true);
    const wb = await openDownloaded();
    expect(wb.sheets).toHaveLength(3);
    // 零件版页脚：F15「送货人：李四」、A17「送货日期：…年…月…日」（整串嵌在模板文案里）
    expect(String(wb.sheets[0]!.rows[14]![5])).toContain('李四');
    expect(String(wb.sheets[0]!.rows[16]![0])).toMatch(/送货日期：\s*\d{4}年\d{1,2}月\d{1,2}日/);
  });
});
