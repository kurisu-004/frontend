// 2026-10-05 新增：usePartBatchShared 纯函数单测 —— toMoneyString。
// 2026-10-17 追加：findCustomerLabel / resolveRootCustomerId（客户无限层级改造）。
//
// 锁的是「含税单价 / 总价 → 后端 Decimal 契约字符串」这条边界：
// 建单入参是 rust rust_decimal + serde-with-str，只认字符串，且列标度固定 2 位。
// 表格里的总价是裸浮点乘出来的（0.1 * 3 === 0.30000000000000004），直接 String()
// 发出去会被 Decimal 如实解析成 13 位小数 —— 这条 helper 是唯一的收口点。
import { describe, expect, it } from 'vitest';
import { ref as vueRef } from 'vue';

import type { Customer } from '@/api/customer';
import {
  findCustomerLabel,
  resolveRootCustomerId,
  runWithConcurrency,
  toMoneyString,
} from '../usePartBatchShared';

describe('toMoneyString', () => {
  it('缺价（null / undefined / NaN / ±Infinity）→ undefined，让调用方不发该键', () => {
    expect(toMoneyString(null)).toBeUndefined();
    expect(toMoneyString(undefined)).toBeUndefined();
    expect(toMoneyString(Number.NaN)).toBeUndefined();
    expect(toMoneyString(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(toMoneyString(Number.NEGATIVE_INFINITY)).toBeUndefined();
    // 不能折成 '0'：那会把「用户没填价」和「用户明确填了 0 元」混成同一个语义
    expect(toMoneyString(null)).not.toBe('0');
  });

  it('浮点尾数被抹平（0.1 * 3 = 0.30000000000000004）', () => {
    // 先证明这个坑真实存在：裸乘确实有 17 位尾数
    expect(String(0.1 * 3)).toBe('0.30000000000000004');
    expect(toMoneyString(0.1 * 3)).toBe('0.30');
    // String() 会把这串尾数原样发出去，被 Decimal 如实解析
    expect(toMoneyString(0.1 * 3)).not.toBe(String(0.1 * 3));
  });

  it('补齐到固定 2 位小数（整数 / 1 位小数都补零）', () => {
    expect(toMoneyString(0)).toBe('0.00');
    expect(toMoneyString(95)).toBe('95.00');
    expect(toMoneyString(1.5)).toBe('1.50');
    expect(toMoneyString(0.1)).toBe('0.10');
    // 已带 2 位：幂等
    expect(toMoneyString(95.25)).toBe('95.25');
    expect(toMoneyString(0.3)).toBe('0.30');
  });

  it('超过 2 位按四舍五入截到 2 位（对齐 NUMERIC(12,2) 标度）', () => {
    expect(toMoneyString(1.005)).toBe('1.00');
    expect(toMoneyString(1.006)).toBe('1.01');
    expect(toMoneyString(12.345)).toBe('12.35');
    expect(toMoneyString(12.344)).toBe('12.34');
    // 输出恒为 2 位小数：不允许出现 '12' / '12.3' 这类短形态
    for (const n of [0, 1, 12, 123, 1234, 0.5, 12.5]) {
      expect(toMoneyString(n)).toMatch(/^-?\d+\.\d{2}$/);
    }
  });

  it('负值保留符号（表里有 min=0 兜底，但 helper 自身不吞符号）', () => {
    expect(toMoneyString(-1.5)).toBe('-1.50');
  });
});

// ============================================================================
// 客户展示与根客户解析（2026-10-17 客户无限层级改造）
// ============================================================================

describe('findCustomerLabel / resolveRootCustomerId', () => {
  /** 任意深度客户树：某某集团 / 终端BG / 手机部 / 影像组（根节点 customer_path = 自己名字）。 */
  const tree: Customer[] = [
    {
      id: 'g',
      name: '某某集团',
      parent_id: null,
      parent_name: null,
      serial_prefix: 'A',
      customer_path: '某某集团',
      version: 1,
      created_at: '',
      updated_at: '',
    },
    {
      id: 'bg',
      name: '终端BG',
      parent_id: 'g',
      parent_name: '某某集团',
      serial_prefix: null,
      customer_path: '终端BG',
      version: 1,
      created_at: '',
      updated_at: '',
    },
    {
      id: 'd',
      name: '手机部',
      parent_id: 'bg',
      parent_name: '终端BG',
      serial_prefix: null,
      customer_path: '终端BG / 手机部',
      version: 1,
      created_at: '',
      updated_at: '',
    },
    {
      id: 'l',
      name: '影像组',
      parent_id: 'd',
      parent_name: '手机部',
      serial_prefix: null,
      customer_path: '终端BG / 手机部 / 影像组',
      version: 1,
      created_at: '',
      updated_at: '',
    },
    // 根节点自身：customer_path 恰等于自己的名字
    {
      id: 'solo',
      name: '独立客户',
      parent_id: null,
      parent_name: null,
      serial_prefix: 'B',
      customer_path: '独立客户',
      version: 1,
      created_at: '',
      updated_at: '',
    },
    // 客户软删 / 父链成环 ⇒ 后端必填字段落空串
    {
      id: 'gone',
      name: '已软删客户',
      parent_id: null,
      parent_name: null,
      serial_prefix: null,
      customer_path: '',
      version: 1,
      created_at: '',
      updated_at: '',
    },
  ];
  const ref = vueRef<Customer[]>(tree);

  it('R1：label 取 customer_path（第 2 层到叶子、不含 L1），不再前端拼 parent/name', () => {
    expect(findCustomerLabel(ref, 'l')).toBe('终端BG / 手机部 / 影像组');
    expect(findCustomerLabel(ref, 'g')).toBe('某某集团');
    expect(findCustomerLabel(ref, 'solo')).toBe('独立客户');
    // 旧实现会拼 `parent_name / name`：第 4 层叶子会得到「手机部 / 影像组」——
    // 中间那层「终端BG」被整层跳过。显式断掉这个退化形态。
    expect(findCustomerLabel(ref, 'l')).not.toBe('手机部 / 影像组');
    expect(findCustomerLabel(ref, 'l')).toContain('终端BG');
  });

  it('R2：customer_path 为空串时退回单段名（软删 / 成环的兜底）', () => {
    expect(findCustomerLabel(ref, 'gone')).toBe('已软删客户');
  });

  it('R3：id 为 null / 查无此客户 → 空串', () => {
    expect(findCustomerLabel(ref, null)).toBe('');
    expect(findCustomerLabel(ref, 'no-such')).toBe('');
  });

  it('R4：任意深度上溯都拿到**根**客户 id（序列号前缀只有一级客户有）', () => {
    // 这条是本轮改动的核心：旧实现只上溯一层，对第 3 层及更深的叶子会返回**直接父**。
    expect(resolveRootCustomerId(ref, 'g')).toBe('g');
    expect(resolveRootCustomerId(ref, 'bg')).toBe('g');
    expect(resolveRootCustomerId(ref, 'd')).toBe('g');
    expect(resolveRootCustomerId(ref, 'l')).toBe('g');
    // 显式断掉「只上溯一层」：第 4 层叶子的直接父是 'd'，不是 'g'
    expect(resolveRootCustomerId(ref, 'l')).not.toBe('d');
  });

  it('R5：null / 空串 / 查无此客户 → null（不发一串垃圾进写端点）', () => {
    expect(resolveRootCustomerId(ref, null)).toBeNull();
    expect(resolveRootCustomerId(ref, '')).toBeNull();
    expect(resolveRootCustomerId(ref, 'no-such')).toBeNull();
  });
});

// ============================================================================
// 受控并发跑批（2026-10-21 从提交段提到共享模块）
// ============================================================================
//
// 为什么直测这一条：它是 PDF Tab 两个消费方（图纸 / 3D 上传的 runUploadJobs、装配件建单
// 的 createAssemblyGroups）共用的**唯一**并发闸门，但两个调用方的用例都观测不到它自己 ——
// 它们各自把 limit 写死在自己的常量里，天然满足「不超发」。「不超发」这件事只有直接对着
// runWithConcurrency 量在途峰值才测得到。
describe('runWithConcurrency', () => {
  it('C1：空 items 立即 resolve，fn 零调用', async () => {
    let calls = 0;
    await expect(
      runWithConcurrency([], 3, async () => {
        calls += 1;
      }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  it('C2：同时在跑的 fn 不超过 limit，且每个 item / 每个下标都恰好跑过一次', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    const byItem: number[] = [];
    const byIdx: number[] = [];

    await runWithConcurrency(items, 2, async (it, idx) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      byItem.push(it);
      byIdx.push(idx);
      // 让出事件循环：不限并发时 10 个会同时进到这里，峰值一下顶到 10
      await new Promise((r) => setTimeout(r, 0));
      inFlight -= 1;
    });

    // 并发钳位：这是本函数存在的**唯一**理由
    expect(peak).toBeLessThanOrEqual(2);
    // 也不能钳过头：limit=2 就是要 2 路并行，钳成 1 就是退化成串行
    expect(peak).toBe(2);
    // 10 个全跑过，一个不落（钳位不能靠少跑来达成）
    expect([...byItem].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // idx 是调用方回填失败清单的排序锚，必须逐项对应、且是连续的 0..n-1
    expect([...byIdx].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('C3：单项抛错照常冒泡给调用方（共享层不吞），其余 item 仍全部被跑过', async () => {
    const ran: number[] = [];
    // limit=2 + 8 个 item：worker A 拿 0→2（抛错退出），worker B 从 3 一路接手到 7
    const promise = runWithConcurrency(
      Array.from({ length: 8 }, (_, i) => i),
      2,
      async (it) => {
        ran.push(it);
        if (it === 2) throw new Error('boom');
      },
    );

    // ① 异常不被共享层吞掉：吞掉的话调用方会拿到「这一批全部跑完了」的假象，一个失败的
    //    item 静默消失，而它代表的请求要么没发出去、要么结果不明。
    await expect(promise).rejects.toThrow('boom');
    // ② 抛错的 worker 退出后，其余 worker 接手把剩下的 item 跑完 —— doc 承诺的
    //    「单个 item 抛错不影响其它 item」就是这一条（不靠共享层兜底，靠还有别的 worker）。
    await new Promise((r) => setTimeout(r, 0));
    expect([...ran].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('C4：limit=1 时抛错的 item 会把它后面的 item 全部带走 ⇒ 每个 fn 必须自己 try/catch', async () => {
    const ran: number[] = [];
    // 单 worker：第 1 个抛错后没人接手，2..4 再也不会被跑到。共享层不提供任何保护，
    // 两个调用方（上传 job / 装配件建单）各自的失败语义完全不同，只能各自在 fn 里兜。
    const promise = runWithConcurrency(
      Array.from({ length: 5 }, (_, i) => i),
      1,
      async (it) => {
        ran.push(it);
        if (it === 1) throw new Error('boom');
      },
    );
    await expect(promise).rejects.toThrow('boom');
    expect(ran).toEqual([0, 1]);
  });
});
