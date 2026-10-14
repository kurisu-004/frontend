// useApplicantSearch 单元测试（2026-10-17）。
//
// 盯的核心不变量：**「加载失败」必须与「从未加载过」完全同形**。
//
// 改前 `loadForCustomer` 的 catch 只清 `applicants`，而 `rootCustomerId` 早在
// fetch **之前**就被赋成 rootId ⇒ 失败后库房里留下一份
// 「rootCustomerId = X、applicants = []」的假权威缓存。消费方
// （`usePartBatchManual.submitStagedEntries`）正是拿
// `applicantSearch.rootCustomerId.value === rootId` 判定「这份缓存属于同一 L1、
// 可以信」，于是对着一个**空**缓存下了这个结论。这类 bug 不报错、只在特定
// 时序（先切客户 → 列表接口失败 → 立刻提交）下让 dedupe 前提失效，
// 所以只能靠不变式断言钉住。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchApplicantsMock = vi.fn();
vi.mock('@/api/applicant', () => ({
  searchApplicants: (params: unknown) => searchApplicantsMock(params),
}));

import { useApplicantSearch } from '../useApplicantSearch';
import type { Applicant } from '@/types/applicant';

function applicantFixture(id: string, name: string, customerId: string): Applicant {
  return {
    id,
    version: 1,
    name,
    customer_id: customerId,
    customer_name: '客户A',
    created_at: '2026-10-17 08:00:00',
    updated_at: '2026-10-17 08:00:00',
  };
}

/** 一级客户 c1 下的申请人；`resolveRootCustomerId` 恒把任意 id 解析成 c1。 */
function makeSearch() {
  return useApplicantSearch({ resolveRootCustomerId: () => 'c1' });
}

beforeEach(() => {
  searchApplicantsMock.mockReset();
});

describe('useApplicantSearch', () => {
  it('加载成功：缓存归属与数据一并落位', async () => {
    searchApplicantsMock.mockResolvedValue([applicantFixture('a1', 'bob', 'c1')]);
    const s = makeSearch();

    await s.loadForCustomer('c1');

    expect(s.rootCustomerId.value).toBe('c1');
    expect(s.applicants.value.map((a) => a.id)).toEqual(['a1']);
    expect(s.loading.value).toBe(false);
  });

  it('★ 加载失败：rootCustomerId 被清空（失败态 == 从未加载态）', async () => {
    searchApplicantsMock.mockRejectedValue(new Error('500'));
    const s = makeSearch();

    await s.loadForCustomer('c1');

    // 两条一起断：根标识必须是 null，否则消费方会误判「缓存属于 c1」
    expect(s.applicants.value).toEqual([]);
    expect(s.rootCustomerId.value).toBeNull();
    expect(s.loading.value).toBe(false);
  });

  it('加载失败后可重试：rootCustomerId 为 null 时再次 loadForCustomer 会重新拉', async () => {
    searchApplicantsMock.mockRejectedValueOnce(new Error('500'));
    const s = makeSearch();
    await s.loadForCustomer('c1');
    expect(s.rootCustomerId.value).toBeNull();

    searchApplicantsMock.mockResolvedValueOnce([applicantFixture('a1', 'bob', 'c1')]);
    await s.loadForCustomer('c1');

    expect(searchApplicantsMock).toHaveBeenCalledTimes(2);
    expect(s.rootCustomerId.value).toBe('c1');
    expect(s.applicants.value.map((a) => a.id)).toEqual(['a1']);
  });

  it('切到空客户 / 解析不到一级：两条都清空（回归守卫，防将来只清一条）', async () => {
    searchApplicantsMock.mockResolvedValue([applicantFixture('a1', 'bob', 'c1')]);
    const s = makeSearch();
    await s.loadForCustomer('c1');
    expect(s.rootCustomerId.value).toBe('c1');

    await s.loadForCustomer(null);
    expect(s.rootCustomerId.value).toBeNull();
    expect(s.applicants.value).toEqual([]);

    const unresolvable = useApplicantSearch({ resolveRootCustomerId: () => null });
    await unresolvable.loadForCustomer('c1');
    expect(unresolvable.rootCustomerId.value).toBeNull();
    expect(unresolvable.applicants.value).toEqual([]);
  });
});
