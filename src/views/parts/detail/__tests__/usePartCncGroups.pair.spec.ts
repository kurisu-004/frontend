// views/parts/detail/__tests__/usePartCncGroups.pair.spec.ts
//
// `onPairUpload`（CNC G 代码 × 设定单 配对上传）的两条收场守卫。
//
// 为什么单独一份 spec：读侧 `cncSetupGroups` 是靠库里两行的 `paired_file_id` 配对的，
// 而配对关系**只在真的走完 confirm 时才成立** —— 秒传短路那一支不发 confirm、
// `pair_with_file_id` 不上行，后端 confirm 走 (owner, kind, sha) 兜底也只是返回既有行、
// 不做 pair 互写。改前这里把秒传命中按成功收，于是库里的设定单仍是「未配对」桶的一员，
// 界面上却一切正常 —— 零报错、零测试信号。
// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';

const mocks = vi.hoisted(() => ({
  directUpload: vi.fn(),
  invalidate: vi.fn(),
  listPartFilesByOwner: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('@/utils/directUpload', () => ({
  directUpload: (o: unknown) => mocks.directUpload(o),
}));

vi.mock('@/api/files/objects', () => ({
  deletePartFile: vi.fn(),
  getPartFileDownloadUrl: vi.fn(),
}));

vi.mock('@/composables/queries/usePartFilesListQuery', () => ({
  usePartFilesListQuery: () => ({
    data: ref({ items: [], total: 0 }),
    isFetching: ref(false),
    fetchList: vi.fn(),
  }),
  invalidatePartFilesListQuery: (...args: unknown[]) => mocks.invalidate(...args),
}));

vi.mock('@/composables/usePermissions', () => ({
  usePermissions: () => ({ isManager: ref(true), isCncProgrammer: ref(false) }),
}));

vi.mock('element-plus', () => ({
  ElMessage: {
    error: (...a: unknown[]) => mocks.error(...a),
    success: (...a: unknown[]) => mocks.success(...a),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

import { usePartCncGroups } from '../composables/usePartCncGroups';

/**
 * 起一个装了 Pinia + VueQuery 的 harness 组件，好让 composable 里的 hook 有上下文
 * （`useQueryClient` 必须在真实 setup 上下文里跑）。
 */
function harness() {
  let api: ReturnType<typeof usePartCncGroups> | null = null;
  const Harness = defineComponent({
    setup() {
      api = usePartCncGroups(ref('p1'));
      return () => h('div');
    },
  });
  const wrapper = mount(Harness, {
    global: {
      plugins: [
        createPinia(),
        [VueQueryPlugin, { queryClient: new QueryClient() }],
      ],
    },
  });
  return { api: api!, wrapper };
}

const gcode = new File([new Uint8Array([1, 2, 3])], 'o1234.nc', { type: 'text/plain' });
// ⚠️ 扩展名必须是 `.pdf`：后端 `policy::allowed_exts("SETUP_SHEET")` 只有 `["pdf"]`
//   （G_CODE 那侧才是 `.nc` 族）。`directUpload` 在本文件里被 mock，所以写成 `.nc`
//   断言照样过 —— 但那会让后来人以为 `.nc` 设定单合法。
const setup = new File([new Uint8Array([4, 5, 6])], 'setup.pdf', { type: 'application/pdf' });
const gcode2 = new File([new Uint8Array([7, 8, 9])], 'o5678.nc', { type: 'text/plain' });

beforeEach(() => {
  mocks.directUpload.mockReset();
  mocks.error.mockReset();
  mocks.success.mockReset();
  mocks.invalidate.mockReset();
});

describe('usePartCncGroups::onPairUpload', () => {
  it('正常路径：设定单走完 confirm（alreadyExists=false）⇒ 报成功，且带上 pairWithFileId', async () => {
    mocks.directUpload
      .mockResolvedValueOnce({ item: { id: 'g-file-1' }, alreadyExists: false })
      .mockResolvedValueOnce({ item: { id: 's-file-1' }, alreadyExists: false });
    const { api, wrapper } = harness();

    const ok = await api.onPairUpload([gcode], setup);

    expect(ok).toBe(true);
    expect(mocks.directUpload).toHaveBeenCalledTimes(2);
    expect(mocks.directUpload.mock.calls[1]![0]).toMatchObject({
      kind: 'SETUP_SHEET',
      pairWithFileId: 'g-file-1',
    });
    expect(mocks.success).toHaveBeenCalledTimes(1);
    expect(mocks.error).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('⚠️ 设定单秒传命中 ⇒ 抛失败而不是按成功收（秒传那支不发 confirm，配对建立不起来）', async () => {
    mocks.directUpload
      .mockResolvedValueOnce({ item: { id: 'g-file-1' }, alreadyExists: false })
      .mockResolvedValueOnce({ item: { id: 'old-setup' }, alreadyExists: true });
    const { api, wrapper } = harness();

    const ok = await api.onPairUpload([gcode], setup);

    expect(ok).toBe(false);
    // 提示必须点名「配对没建起来」+ 给出补救动作，否则用户只会看到一句「配对上传失败」。
    expect(String(mocks.error.mock.calls[0]![0])).toContain('没能把它与刚传的 G 代码配对');
    expect(String(mocks.error.mock.calls[0]![0])).toContain('删掉那份旧的设定单');
    // 绝不能同时弹成功 —— 那正是「界面上一切正常、库里两行都没配对」的成因。
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  // ⚠️ **N≥2 必须被拒**：后端 `bind_uploaded_file` 对单文件 kind 一律先
  //   `soft_delete_active_by_part_kind` 再 INSERT，kind 清单含 G_CODE ⇒ 第二个 G 代码会
  //   把第一个**静默顶掉**（DB 的 `uk_t_part_file_single` 部分唯一索引不含 G_CODE，
  //   所以连约束报错都没有）；同一份设定单第二遍也必然秒传短路 ⇒ 配对建立不起来。
  //   改前 UI 是 `multiple` + 「可多个」，选 2 个 ⇒ 第 2 轮撞秒传短路 ⇒ 报错「请删除旧的
  //   设定单」—— 而那份「旧的」正是第 1 轮刚传的，删了重试又撞，**UI 上无出路**。
  it('⚠️ 选了 2 个 G 代码 ⇒ 入口就拒，零请求零写入（而不是传到一半再失败）', async () => {
    mocks.directUpload.mockResolvedValue({ item: { id: 'g-1' }, alreadyExists: false });
    const { api, wrapper } = harness();

    const ok = await api.onPairUpload([gcode, gcode2], setup);

    expect(ok).toBe(false);
    // 零请求：连第一个 G 代码都不该传（传了也只剩最后一个，前面的静默丢失）
    expect(mocks.directUpload).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledTimes(1);
    const msg = String(mocks.error.mock.calls[0]![0]);
    // 提示要说清**为什么**是单选（顶掉上一份），否则用户会以为是限制写错了
    expect(msg).toContain('只能配一对');
    expect(msg).toContain('顶掉上一份');
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('G 代码本身秒传命中不阻断（它没有配对语义，配对锚取既有行的 id 即可）', async () => {
    mocks.directUpload
      .mockResolvedValueOnce({ item: { id: 'g-existing' }, alreadyExists: true })
      .mockResolvedValueOnce({ item: { id: 's-file-1' }, alreadyExists: false });
    const { api, wrapper } = harness();

    const ok = await api.onPairUpload([gcode], setup);

    expect(ok).toBe(true);
    expect(mocks.directUpload.mock.calls[1]![0]).toMatchObject({ pairWithFileId: 'g-existing' });
    wrapper.unmount();
  });
});
