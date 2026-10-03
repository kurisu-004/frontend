// src/composables/__tests__/usePagedListQuery.spec.ts
//
// 2026-10-04 新增：<PagedTable> 底层分页 composable 的契约守卫（本 composable 此前零覆盖）。
//
// 锁两件事：
//   ① reset() 一定要重新拉一次。view 的真实筛选条件（customer_id / status / date range）
//     放在 view 本地 reactive 里、只在 fetcher 闭包中读，本 composable 的 watcher 看不见，
//     所以「重新拉」唯一可依赖的信号就是自己手里的 ref —— 而 Vue 同值赋值不触发 watcher，
//     「已在第 1 页 + keyword 已空」时一次请求都不发（线上现象：点重置无反应、列表永远
//     停在旧结果）。三种情形（page≠1 / page===1 且 keyword 有值 / page===1 且 keyword 已空）
//     都必须恰好发一次。作用域限于「同一 tick 内 pageSize 也没变」—— 同 tick 内若还有
//     pageSize 变更（如与 PagedTable setup 期写 defaultPageSize 撞一起），会被
//     suppressSetupChange 守卫整条吞掉，边界见 usePagedListQuery.ts 文件头 2026-10-04 段。
//   ② PagedTable 在 setup 内同步写 defaultPageSize 触发的首次 watcher 必须仍被抑制
//     （首屏拉取入口是 consumer 显式 fetch()，不是这次 watcher），且 onSearch 仍只改 ref。
//
// 本文件只跑 node 环境，不需要 DOM / pinia / TanStack Query。

import { describe, it, expect, vi } from 'vitest';
import { nextTick } from 'vue';
import { usePagedListQuery, type PageQueryParams } from '../usePagedListQuery';

interface Row {
  id: number;
}

/** 造一个 fetcher 计数用的最小实例（空页结果，省去数据形状噪音）。 */
function makeInstance() {
  const fetcher = vi.fn((_params: PageQueryParams) =>
    Promise.resolve({ items: [] as Row[], total: 0 }),
  );
  const paged = usePagedListQuery<Row>(fetcher);
  return { fetcher, paged };
}

/** 冲刷 watcher 队列，并等 watcher 内部 fetch() 的 await 续延跑完。 */
async function flush(): Promise<void> {
  await nextTick();
  await Promise.resolve();
}

describe('usePagedListQuery reset：一定要重新拉一次', () => {
  it('A1【回归点】初始即 page=1 且 keyword 为空 → reset() 恰好触发 1 次 fetch', async () => {
    const { fetcher, paged } = makeInstance();

    const pending = paged.reset();
    // 同步栈内不发请求：所有触发都经 watcher 入队
    expect(fetcher).toHaveBeenCalledTimes(0);
    await pending;
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    // 复位后的请求参数是「第 1 页 + 无 keyword」
    expect(fetcher).toHaveBeenCalledWith({ page: 1, pageSize: 20, keyword: undefined });
  });

  it('A2 已在第 3 页 → reset() 恰好 1 次（page 变化与 reloadToken 不重复触发）', async () => {
    const { fetcher, paged } = makeInstance();

    paged.page.value = 3;
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await paged.reset();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith({ page: 1, pageSize: 20, keyword: undefined });
  });

  it('A3 已在第 1 页但 keyword 有值 → reset() 恰好 1 次', async () => {
    const { fetcher, paged } = makeInstance();

    paged.onSearch('ABC');
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await paged.reset();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith({ page: 1, pageSize: 20, keyword: undefined });
  });

  it('A4 同一 tick 内连调两次 reset() → 只 1 次 fetch（watcher 批处理去重）', async () => {
    const { fetcher, paged } = makeInstance();

    void paged.reset();
    void paged.reset();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('A5 reset 后 items / total 被 fetcher 结果覆盖（不残留上一批数据）', async () => {
    const fetcher = vi
      .fn<() => Promise<{ items: Row[]; total: number }>>()
      .mockResolvedValueOnce({ items: [{ id: 1 }], total: 99 })
      .mockResolvedValueOnce({ items: [], total: 0 });
    const paged = usePagedListQuery<Row>(fetcher);

    await paged.fetch();
    expect(paged.items.value).toHaveLength(1);
    expect(paged.total.value).toBe(99);

    await paged.reset();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(paged.items.value).toEqual([]);
    expect(paged.total.value).toBe(0);
  });
});

describe('usePagedListQuery PagedTable 抑制守卫 / onSearch 语义', () => {
  it('B1 defaultPageSize 在 setup 内同步生效触发的首次 watcher 被抑制（不发请求）', async () => {
    const { fetcher, paged } = makeInstance();

    // 等价于 <PagedTable :default-page-size="50">：setup 内 pageSize 20 → 50
    paged.pageSize.value = 50;
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(0);

    // 首屏真正的拉取入口是 consumer 显式 fetch()
    await paged.fetch();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenLastCalledWith({ page: 1, pageSize: 50, keyword: undefined });
  });

  it('B2 defaultPageSize 与初始值相同（20）→ 值未变，根本不触发 watcher', async () => {
    const { fetcher, paged } = makeInstance();

    paged.pageSize.value = 20;
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(0);
  });

  it('B3 抑制守卫不吞后续用户交互：pageSize 被 setup 改过后再 reset 仍发一次', async () => {
    const { fetcher, paged } = makeInstance();

    paged.pageSize.value = 50;
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(0);

    await paged.reset();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenLastCalledWith({ page: 1, pageSize: 50, keyword: undefined });
  });

  it('B4 onSearch 只改 ref 不同步发请求，随后经 watcher 发一次', async () => {
    const { fetcher, paged } = makeInstance();

    paged.onSearch('图纸');
    expect(fetcher).toHaveBeenCalledTimes(0);
    expect(paged.keyword.value).toBe('图纸');
    expect(paged.page.value).toBe(1);

    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenLastCalledWith({ page: 1, pageSize: 20, keyword: '图纸' });
  });

  it('B5 onSearch 在非第 1 页时把 page 复位到 1，只发一次', async () => {
    const { fetcher, paged } = makeInstance();

    paged.page.value = 4;
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    paged.onSearch('图纸');
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith({ page: 1, pageSize: 20, keyword: '图纸' });
  });
});
