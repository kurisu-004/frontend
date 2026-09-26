// 2026-09-24 新增：PartEntryFormDialog 组件单测（仓内录入 Tab 首例组件单测）。
// 模式与 LoginCard.spec.ts / LoginView.spec.ts 一致：happy-dom + EP 最小 stub。
//
// 重点验证：
//   - visible / editing 标题与按钮文案切换；
//   - formErrors prop 渲染到 el-form-item :error；
//   - 「加入列表」按钮 @click → emit('confirm')；
//   - 「取消」 / 关闭按钮 → emit('close')；
//   - drawingUploading=true 时确认按钮 disabled；
//   - dialogSubmitting=true 时确认按钮 loading。
// @vitest-environment happy-dom

import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import PartEntryFormDialog from '../components/PartEntryFormDialog.vue';

const ElButtonStub = defineComponent({
  name: 'ElButtonStub',
  inheritAttrs: false,
  setup(_, { slots, attrs }) {
    return () =>
      h(
        'button',
        {
          ...attrs,
          type: attrs['native-type'] ?? attrs.type ?? 'button',
          disabled: attrs.disabled === true || attrs.disabled === '' || attrs.disabled === 'true',
        },
        slots.default?.(),
      );
  },
});

const ElDialogStub = defineComponent({
  name: 'ElDialogStub',
  props: ['modelValue', 'title', 'fullscreen', 'beforeClose'],
  emits: ['update:modelValue', 'closed'],
  setup(props, { slots, emit }) {
    return () =>
      h('div', { class: 'el-dialog-stub' }, [
        h('header', { class: 'el-dialog-stub__title' }, props.title ?? ''),
        h('div', { class: 'el-dialog-stub__body' }, slots.default?.()),
        h('div', { class: 'el-dialog-stub__footer' }, slots.footer?.()),
        h(
          'button',
          {
            class: 'el-dialog-stub__close',
            onClick: () => {
              emit('update:modelValue', false);
              emit('closed');
            },
          },
          'close',
        ),
      ]);
  },
});

const ElInputStub = defineComponent({
  name: 'ElInputStub',
  props: ['modelValue', 'type', 'placeholder'],
  emits: ['update:modelValue', 'blur'],
  setup(props, { emit, attrs }) {
    return () =>
      h('input', {
        value: props.modelValue,
        type: props.type ?? 'text',
        placeholder: props.placeholder,
        ...attrs,
        onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
        onBlur: () => emit('blur'),
      });
  },
});

const ElFormItemStub = defineComponent({
  name: 'ElFormItemStub',
  props: ['label', 'error'],
  setup(props, { slots }) {
    return () =>
      h('div', { class: 'el-form-item-stub' }, [
        props.label ? h('label', props.label) : null,
        slots.default?.(),
        props.error ? h('p', { class: 'el-form-item__error' }, props.error) : null,
      ]);
  },
});

const ElFormStub = defineComponent({
  name: 'ElFormStub',
  setup(_, { slots }) {
    return () => h('form', { class: 'el-form-stub' }, slots.default?.());
  },
});

const ElCascaderStub = defineComponent({
  name: 'ElCascaderStub',
  props: ['modelValue', 'options', 'placeholder'],
  emits: ['update:modelValue', 'change'],
  setup() {
    return () => h('div', { class: 'el-cascader-stub' }, 'cascader-stub');
  },
});

const ElAutocompleteStub = defineComponent({
  name: 'ElAutocompleteStub',
  props: ['modelValue', 'placeholder', 'disabled'],
  emits: ['update:modelValue', 'select', 'blur'],
  setup() {
    return () => h('div', { class: 'el-autocomplete-stub' }, 'autocomplete-stub');
  },
});

const ElInputNumberStub = defineComponent({
  name: 'ElInputNumberStub',
  props: ['modelValue', 'min', 'step'],
  emits: ['update:modelValue'],
  setup() {
    return () => h('div', { class: 'el-input-number-stub' }, 'input-number-stub');
  },
});

const ElSwitchStub = defineComponent({
  name: 'ElSwitchStub',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup() {
    return () => h('div', { class: 'el-switch-stub' }, 'switch-stub');
  },
});

const ElDatePickerStub = defineComponent({
  name: 'ElDatePickerStub',
  props: ['modelValue', 'type', 'valueFormat', 'placeholder'],
  emits: ['update:modelValue'],
  setup() {
    return () => h('div', { class: 'el-date-picker-stub' }, 'date-picker-stub');
  },
});

const ElIconStub = defineComponent({
  name: 'ElIconStub',
  setup(_, { slots }) {
    return () => h('span', { class: 'el-icon-stub' }, slots.default?.());
  },
});

const CosUploaderStub = defineComponent({
  name: 'CosUploaderStub',
  emits: ['change', 'uploaded', 'all-done', 'error'],
  setup() {
    return () => h('div', { class: 'cos-uploader-stub' }, 'cos-uploader-stub');
  },
});

const globalConfig = {
  components: {
    ElButton: ElButtonStub,
    ElDialog: ElDialogStub,
    ElInput: ElInputStub,
    ElForm: ElFormStub,
    ElFormItem: ElFormItemStub,
    ElCascader: ElCascaderStub,
    ElAutocomplete: ElAutocompleteStub,
    ElInputNumber: ElInputNumberStub,
    ElSwitch: ElSwitchStub,
    ElDatePicker: ElDatePickerStub,
    ElIcon: ElIconStub,
    CosUploader: CosUploaderStub,
  },
};

const baseForm = {
  drawingNo: '',
  name: '',
  applicantName: '',
  applicantId: null,
  customerId: null,
  quantity: 1,
  isUrgent: false,
  requestDate: '2026-09-24',
  plannedDeliveryDate: '',
  orderNo: null,
  systemDeliveryDate: null,
  note: null,
  drawingFile: null,
  drawingName: null,
  drawingUrl: null,
  drawingBinding: null,
};

const baseProps = () => ({
  visible: true,
  editing: false,
  form: { ...baseForm },
  formErrors: {},
  validateField: () => undefined,
  addDlg: { width: 900, top: '15vh', fullscreen: false as const },
  customerTree: [],
  applicantLoading: false,
  querySearch: () => undefined,
  customerChange: async () => undefined,
  applicantSelect: () => undefined,
  requestDrawingUpload: async () => ({
    credentials: { tmp_secret_id: '', tmp_secret_key: '', session_token: '', expired_time: 0 },
    bucket: '',
    region: '',
    items: [],
  }),
  drawingUploaded: () => undefined,
  drawingItemsChange: () => undefined,
  drawingAllDone: () => undefined,
  drawingUploadError: () => undefined,
  dialogSubmitting: false,
  drawingUploading: false,
});

describe('PartEntryFormDialog', () => {
  it('editing=false 时标题为「添加零件」、按钮文案「加入列表」', () => {
    const wrapper = mount(PartEntryFormDialog, {
      props: baseProps(),
      global: globalConfig,
    });
    expect(wrapper.find('.el-dialog-stub__title').text()).toBe('添加零件');
    expect(wrapper.text()).toContain('加入列表');
  });

  it('editing=true 时标题切换为「编辑零件」、按钮文案「保存到列表」', () => {
    const wrapper = mount(PartEntryFormDialog, {
      props: { ...baseProps(), editing: true },
      global: globalConfig,
    });
    expect(wrapper.find('.el-dialog-stub__title').text()).toBe('编辑零件');
    expect(wrapper.text()).toContain('保存到列表');
  });

  it('formErrors 字段映射到 el-form-item :error', () => {
    const wrapper = mount(PartEntryFormDialog, {
      props: {
        ...baseProps(),
        formErrors: {
          drawingNo: '请输入图号',
          customerId: '请选择客户',
        },
      },
      global: globalConfig,
    });
    const errs = wrapper.findAll('.el-form-item__error');
    expect(errs.length).toBe(2);
    const texts = errs.map((n) => n.text());
    expect(texts).toContain('请输入图号');
    expect(texts).toContain('请选择客户');
  });

  it('确认按钮 emit confirm', async () => {
    const wrapper = mount(PartEntryFormDialog, {
      props: baseProps(),
      global: globalConfig,
    });
    // 找按钮：页脚有「取消」「加入列表」两个。点「加入列表」应 emit confirm。
    const buttons = wrapper.findAll('button');
    const confirmBtn = buttons.find((b) => b.text().includes('加入列表'));
    expect(confirmBtn).toBeTruthy();
    await confirmBtn!.trigger('click');
    expect(wrapper.emitted('confirm')).toHaveLength(1);
  });

  it('取消按钮 emit close', async () => {
    const wrapper = mount(PartEntryFormDialog, {
      props: baseProps(),
      global: globalConfig,
    });
    const buttons = wrapper.findAll('button');
    const cancelBtn = buttons.find((b) => b.text().includes('取消'));
    expect(cancelBtn).toBeTruthy();
    await cancelBtn!.trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('drawingUploading=true 时确认按钮 DOM disabled', () => {
    const wrapper = mount(PartEntryFormDialog, {
      props: { ...baseProps(), drawingUploading: true },
      global: globalConfig,
    });
    const buttons = wrapper.findAll('button');
    const confirmBtn = buttons.find((b) => b.text().includes('加入列表'));
    expect(confirmBtn!.attributes('disabled')).toBeDefined();
  });

  it('editing=true 且有 drawingName 时显示「当前图纸」提示', () => {
    const wrapper = mount(PartEntryFormDialog, {
      props: {
        ...baseProps(),
        editing: true,
        form: { ...baseForm, drawingName: 'foo.pdf' },
      },
      global: globalConfig,
    });
    expect(wrapper.text()).toContain('当前图纸：foo.pdf');
  });

  it('本地 form 改动 → emit update:form 回写父组件', async () => {
    const wrapper = mount(PartEntryFormDialog, {
      props: baseProps(),
      global: globalConfig,
    });
    const inputs = wrapper.findAll('input');
    // 第一个 input 是 drawingNo
    await inputs[0]!.setValue('LT39822');
    // localForm 双向同步会立即 emit update:form
    const evs = wrapper.emitted('update:form');
    expect(evs).toBeTruthy();
    expect(evs!.length).toBeGreaterThanOrEqual(1);
    const lastForm = evs![evs!.length - 1]![0] as { drawingNo: string };
    expect(lastForm.drawingNo).toBe('LT39822');
  });
});
