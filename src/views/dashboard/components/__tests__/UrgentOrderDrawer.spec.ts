// @vitest-environment happy-dom
// src/views/dashboard/components/__tests__/UrgentOrderDrawer.spec.ts
//
// 2026-09-29 新增：UrgentOrderDrawer 三态渲染回归保护。
//
// 覆盖：
//   - D1：part = null → drawer-empty 占位「请选择工单」
//   - D2：有 part + 有图（kind='DRAWING' file_type='PDF'）→ 调 fetchPartFileContent
//   - D3：有 part + 无图（files 为空）→ fetchPartFileContent 不被调
//   - D4：usePartFilesListQuery enabled 闸门 —— part = null → 不发请求
//   - D5：v-model 双向同步 —— 修改 modelValue prop 验证子组件接收

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { nextTick } from 'vue';
import type { PartListItem } from '@/types/parts';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElDrawer: {
    name: 'ElDrawer',
    props: ['modelValue', 'direction', 'size', 'withHeader', 'appendToBody', 'destroyOnClose'],
    template: '<div class="mock-drawer" v-if="modelValue"><slot /></div>',
  },
  ElEmpty: { template: '<div class="mock-empty"><slot /></div>' },
  ElIcon: { template: '<i><slot /></i>' },
  ElTag: { props: ['type', 'size', 'effect'], template: '<span class="mock-tag"><slot /></span>' },
  ElTabs: { props: ['modelValue'], template: '<div class="mock-tabs"><slot /></div>' },
  ElTabPane: {
    props: ['label', 'name'],
    template: '<div :data-name="name" class="mock-tab-pane"><slot /></div>',
  },
  ElImage: {
    props: ['src', 'previewSrcList', 'fit'],
    template: '<img :src="src" class="mock-image" />',
  },
}));

const fetchPartFileContentMock = vi.fn();
vi.mock('@/api/parts/file', () => ({
  fetchPartFileContent: (id: string) => fetchPartFileContentMock(id),
}));

const listPartFilesByOwnerMock = vi.fn();
vi.mock('@/api/assembly', () => ({
  listPartFilesByOwner: (ownerId: string) => listPartFilesByOwnerMock(ownerId),
}));

vi.mock('@/components/PdfViewer.vue', () => ({
  default: {
    name: 'PdfViewer',
    props: ['url'],
    template: '<div class="mock-pdf-viewer">{{ url }}</div>',
  },
}));

import UrgentOrderDrawer from '../UrgentOrderDrawer.vue';

function makePart(overrides: Partial<PartListItem> = {}): PartListItem {
  return {
    id: '180000000000001',
    version: 1,
    serial_no: 'SN-001',
    name: '零件甲',
    drawing_no: 'DWG-001',
    applicant_name: '张三',
    quantity: 10,
    unit_price: '0',
    total_price: '0',
    request_date: '2026-09-29',
    planned_delivery_date: '2026-09-30',
    is_urgent: true,
    status: 'PENDING',
    order_no: 'PO-001',
    system_delivery_date: null,
    note: '加急',
    customer_name: '客户甲',
    l1_customer_name: 'L1 客户',
    location: null,
    has_cnc_program: false,
    row_type: 'PART',
    ...overrides,
  };
}

function makeFileItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '300000000000001',
    version: 1,
    owner_id: '180000000000001',
    kind: 'DRAWING',
    file_type: 'PDF',
    original_filename: '零件甲.pdf',
    file_size: '12345',
    content_type: 'application/pdf',
    upload_status: 'READY',
    content_sha256: null,
    created_at: '2026-09-29',
    paired_file_id: null,
    ...overrides,
  };
}

describe('UrgentOrderDrawer — 三态渲染（2026-09-29）', () => {
  let testQueryClient: QueryClient;

  beforeEach(() => {
    fetchPartFileContentMock.mockReset();
    listPartFilesByOwnerMock.mockReset();
    fetchPartFileContentMock.mockResolvedValue(new Blob(['x']));
    testQueryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } });
  });

  afterEach(() => {
    testQueryClient.unmount();
    testQueryClient = null as unknown as QueryClient;
    vi.clearAllMocks();
  });

  /** 2026-09-29 新增：构造 mount option，注入 VueQueryPlugin 与 ElDrawer stub。 */
  function makeMountOpts(part: PartListItem | null) {
    const opts: Parameters<typeof mount>[1] = {
      props: { modelValue: true, part },
      global: {
        plugins: [VueQueryPlugin],
        provide: { VUE_QUERY_CLIENT: testQueryClient },
        stubs: {
          ElDrawer: { template: '<div><slot /></div>' },
        },
      },
    };
    return opts;
  }

  it('D1：part = null → drawer-empty 占位「请选择工单」', async () => {
    const wrapper = mount(UrgentOrderDrawer, makeMountOpts(null));
    await nextTick();
    expect(wrapper.find('.drawer-empty').exists()).toBe(true);
    wrapper.unmount();
  });

  it('D2：有 part + 有图（kind=DRAWING PDF） → fetchPartFileContent 被调', async () => {
    listPartFilesByOwnerMock.mockResolvedValue({
      items: [makeFileItem({ id: '300000000000001', kind: 'DRAWING', file_type: 'PDF' })],
      total: 1,
    });

    const part = makePart();
    const wrapper = mount(UrgentOrderDrawer, makeMountOpts(part));

    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTick();

    expect(listPartFilesByOwnerMock).toHaveBeenCalledWith(part.id);
    expect(fetchPartFileContentMock).toHaveBeenCalled();
    wrapper.unmount();
  });

  it('D3：有 part + 无图（files 为空）→ fetchPartFileContent 不被调', async () => {
    listPartFilesByOwnerMock.mockResolvedValue({
      items: [],
      total: 0,
    });

    const part = makePart();
    const wrapper = mount(UrgentOrderDrawer, makeMountOpts(part));

    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTick();

    // drawings tab 没有任何文件 → 不发 fetchPartFileContent
    expect(fetchPartFileContentMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('D4：usePartFilesListQuery enabled 闸门 —— part = null → 不发请求', async () => {
    const wrapper = mount(UrgentOrderDrawer, makeMountOpts(null));

    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTick();

    expect(listPartFilesByOwnerMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('D5：v-model 双向同步 —— 修改 modelValue prop 验证子组件接收', async () => {
    const wrapper = mount(UrgentOrderDrawer, makeMountOpts(makePart()));
    await nextTick();
    const props1 = wrapper.props() as { modelValue: boolean };
    expect(props1.modelValue).toBe(true);

    await wrapper.setProps({ modelValue: false });
    const props2 = wrapper.props() as { modelValue: boolean };
    expect(props2.modelValue).toBe(false);
    wrapper.unmount();
  });
});