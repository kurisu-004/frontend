// views/parts/detail/__tests__/PartCncCard.spec.ts
//
// CNC 卡（`PartCncCard.vue`）的**配对上传对话框**行为守卫。
//
// 为什么这份 spec 之前不存在：配对上传的多选限制此前只在 composable 层
// （`usePartCncGroups.pair.spec.ts`）被钉住，而 `.vue` 层的「换选」交互**零覆盖** ——
// 于是「注释写替换、代码调 append」这种三方不一致能一路溜到 review（本轮 M1）：
// 用户选 A 再选 B，列表被撑到 2 条，点确认被兜底闸拦下，得先手动删旧条目才走得通。
//
// 这里守三件事：
//   1. G 代码上传控件是**单选**（`limit=1` 且不带 `multiple`）—— 与后端「每个 owner 的
//      G_CODE 只有一条活跃行」的语义对齐；
//   2. 已选 1 个后再触发 `on-exceed`，列表**长度仍为 1** 且装的是新文件（换选=整份替换）；
//   3. 换选的文件扩展名不在白名单时，**保持原列表不动**（不能把用户已选好的也弄丢）。
// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick, type PropType } from 'vue';
import { mount } from '@vue/test-utils';
import type { UploadFile } from 'element-plus';
import PartCncCard from '../components/PartCncCard.vue';

/** EP 薄壳替身：只要 default slot 能渲染即可（本 spec 不依赖它们的内部结构）。 */
const passthrough = (name: string) =>
  defineComponent({
    name,
    inheritAttrs: false,
    setup(_props, { slots }) {
      return () => h('div', { class: name }, slots.default?.());
    },
  });

/**
 * `el-upload` 需要能读回自己的 props（`limit` / `multiple`），并把 `file-list` 里
 * 每一项渲染出来 —— 否则断言「长度仍为 1」就变成在断言组件内部 state 而不是 UI。
 */
const ElUploadStub = defineComponent({
  name: 'ElUpload',
  inheritAttrs: false,
  props: {
    fileList: { type: Array as PropType<UploadFile[]>, default: () => [] },
    limit: { type: Number, default: undefined },
    multiple: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    return () =>
      h('div', { class: 'ElUpload' }, [
        slots.default?.(),
        ...props.fileList.map((f) => h('div', { class: 'ElUpload-row' }, f.name)),
      ]);
  },
});

const globalConfig = {
  components: {
    ElCard: passthrough('ElCard'),
    ElDialog: passthrough('ElDialog'),
    ElEmpty: passthrough('ElEmpty'),
    ElForm: passthrough('ElForm'),
    ElFormItem: passthrough('ElFormItem'),
    ElIcon: passthrough('ElIcon'),
    ElTag: passthrough('ElTag'),
    ElButton: passthrough('ElButton'),
    ElUpload: ElUploadStub,
  },
  directives: {
    // 组件根上挂了 `v-loading`；替身组件不注册该指令，显式给一个空实现免掉告警。
    loading: {},
  },
  stubs: { Upload: true, Cpu: true },
};

/** 一个**真·append** 的 `fileList` 实现（与 `usePartCncGroups.ts` 的契约逐字同款）。 */
function appendingFileList(
  current: UploadFile[],
  file: UploadFile,
  accept: string,
  matchExt = false,
): UploadFile[] {
  if (current.some((f) => f.uid === file.uid)) return current;
  if (matchExt) {
    const exts = accept.replace(/\./g, '').split(',');
    if (!exts.some((e) => (file.name || '').toLowerCase().endsWith('.' + e))) return current;
  }
  return [...current, file];
}

const nc = (name: string): File => new File([new Uint8Array([1, 2, 3])], name);

/** 构造一个 `UploadFile`，形状与组件内部生成的完全同款（EP 的 `raw` 要求带 `uid`）。 */
function entryOf(name: string, uid: number): UploadFile {
  return {
    uid,
    name,
    status: 'ready',
    raw: Object.assign(nc(name), { uid }),
  };
}

function mountCard() {
  return mount(PartCncCard, {
    props: {
      partId: 'p1',
      cncSetupGroups: [],
      cncLoading: false,
      canManageCncFiles: true,
      canManageSetupSheet: true,
      formatBytes: (v: string | number) => `${v} B`,
      fileList: appendingFileList,
      onDownloadCnc: () => undefined,
      onDeleteCnc: () => undefined,
    },
    global: globalConfig,
  });
}

/** `<script setup>` 的绑定在 dev 构建下可从 `vm` 读到（与 PartEntryFormDialog.spec 同手法）。 */
interface CardVm {
  pairGcodeFiles: UploadFile[];
  onPairGcodeChange: (f: UploadFile, list: UploadFile[]) => void;
  onPairGcodeExceed: (files: File[]) => void;
}

const vmOf = (w: ReturnType<typeof mountCard>) => w.vm as unknown as CardVm;

describe('PartCncCard：配对上传对话框的 G 代码单选与换选', () => {
  it('G 代码上传控件是单选（limit=1 且不带 multiple）', () => {
    const w = mountCard();
    const upload = w.findAllComponents({ name: 'ElUpload' })[0]!;
    expect(upload.props('limit')).toBe(1);
    // `multiple` 是布尔 prop：传 true 才会是 true，默认/不传恒为 false ⇒ 这条断言能拦住
    // 「有人又把 `multiple` 加回来」。
    expect(upload.props('multiple')).toBe(false);
    expect(w.text()).toContain('选择 G 代码（单个）');
  });

  it('已选 1 个后再触发 on-exceed：列表长度仍为 1，且装的是新文件（换选=整份替换）', async () => {
    const w = mountCard();
    const vm = vmOf(w);

    vm.onPairGcodeChange(entryOf('o1111.nc', 1), []);
    expect(vm.pairGcodeFiles).toHaveLength(1);
    expect(vm.pairGcodeFiles[0]!.name).toBe('o1111.nc');

    // 第二个：走 exceed 分支
    vm.onPairGcodeExceed([nc('o2222.nc')]);

    // ⚠️ 这条就是本 spec 的存在理由：改回 append（拿当前列表当 `fileList` 的基底）时，
    //   下面这两行会同时红（长度 2、装的还是旧文件）。
    expect(vm.pairGcodeFiles).toHaveLength(1);
    expect(vm.pairGcodeFiles[0]!.name).toBe('o2222.nc');
    // UI 侧也确实只渲染一条
    await nextTick();
    expect(w.findAll('.ElUpload-row').map((n) => n.text())).toEqual(['o2222.nc']);
  });

  it('on-exceed 传入的文件扩展名不在白名单时：保持原列表不动（不能把已选好的也弄丢）', () => {
    const w = mountCard();
    const vm = vmOf(w);

    vm.onPairGcodeChange(entryOf('o1111.nc', 1), []);
    vm.onPairGcodeExceed([nc('o2222.step')]);

    expect(vm.pairGcodeFiles).toHaveLength(1);
    expect(vm.pairGcodeFiles[0]!.name).toBe('o1111.nc');
  });

  it('on-exceed 收到空数组时不改动列表', () => {
    const w = mountCard();
    const vm = vmOf(w);

    vm.onPairGcodeChange(entryOf('o1111.nc', 1), []);
    vm.onPairGcodeExceed([]);

    expect(vm.pairGcodeFiles).toHaveLength(1);
    expect(vm.pairGcodeFiles[0]!.name).toBe('o1111.nc');
  });
});
