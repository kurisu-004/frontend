// `t_part_event.event_type` 前端注册表的完整性守卫（2026-10-17）。
//
// 为什么要单独一条 spec：后端 `t_part_event.event_type` 是 `varchar(30)`、**无 CHECK
// 约束、无 DB ENUM、无 Rust enum** ⇒ 前端 `src/types/parts.ts` 的
// `PART_EVENT_LABEL` / `PART_EVENT_TAG_TYPE` 是**事实上的注册表**。而消费侧
// （`usePartDetail.ts::eventLabel`）的兜底是 `PART_EVENT_LABEL[t] ?? t`，
// 响应 schema 又是 `z.string()`（不是 `z.enum`）⇒ **漏登记一个字面量不会报错，
// 只会让时间线显示英文原文**（`RETURNED_TO_SHELF` 曾长期如此）。
//
// 三个 union / 两张表的「对 PartEventType 穷尽」由 TS 的 `Record<PartEventType, …>`
// 在编译期保证（漏一处 `typecheck` 当场红）；本 spec 补的是**编译期管不到**的那条：
//   1) 两张表的**键集彼此完全相等**（多一个 tag 少一个 label 这类漂移）；
//   2) 2026-10-17 补齐的 12 个新 key 逐个点名存在且中文非空 / tag 合法。
//
// ⚠️ 后端真源是 `backend-rust/src/shared/part_event/mod.rs` 模块 doc 的「写侧域
// 对照表」，**加事件类型必须两侧同改**（纪律同 `DELIVERY_STATUSES` 三副本）。
// 本 spec 刻意**不**去读后端源码文件 —— Docker 构建上下文里只有 frontend 仓，
// 任何跨仓 import 都会直接断构建；同步只能靠人 + 这条测试提醒。

import { describe, expect, it } from 'vitest';
import {
  PART_EVENT_LABEL,
  PART_EVENT_TAG_TYPE,
  SCAN_EVENT_TYPE_OPTIONS,
  type PartEventType,
} from '../parts';

/** 2026-10-17 补齐的 12 个字面量 → [中文, tag]。 */
const NEW_12: Array<[PartEventType, string, string]> = [
  ['RETURNED_TO_SHELF', '归还', 'info'],
  ['SENT_TO_INSPECTION', '工人送检', 'primary'],
  ['TAKEN_FROM_POOL', '队列取件', 'warning'],
  ['MOVED', '队列移动', 'info'],
  ['BATCH_PASSED', '品检通过', 'success'],
  ['BATCH_CANCELLED', '批次取消', 'danger'],
  ['DELIVERED', '已送货', 'success'],
  ['FORCE_COMPLETED', '强制完成', 'warning'],
  ['SERIAL_RELEASED', '序列号释放', 'info'],
  ['SOFT_DELETED', '工单删除', 'danger'],
  ['TRANSFERRED', '扫码接管', 'warning'],
  ['FORCED_SENT_TO_INSPECTION', '强制送检', 'warning'],
];

describe('t_part_event 事件类型 alias 表', () => {
  it('PART_EVENT_LABEL 与 PART_EVENT_TAG_TYPE 的键集完全相等', () => {
    const labelKeys = Object.keys(PART_EVENT_LABEL).sort();
    const tagKeys = Object.keys(PART_EVENT_TAG_TYPE).sort();
    expect(labelKeys).toEqual(tagKeys);
  });

  it('2026-10-17 补齐的 12 个字面量：label / tag 逐个点名存在', () => {
    expect(NEW_12).toHaveLength(12);
    for (const [key, label, tag] of NEW_12) {
      expect(PART_EVENT_LABEL[key], `${key} 缺中文 label`).toBe(label);
      expect(PART_EVENT_TAG_TYPE[key], `${key} 缺 tag`).toBe(tag);
    }
  });

  it('全部已登记字面量的中文非空、tag 落在合法枚举内', () => {
    const TAGS = ['primary', 'success', 'warning', 'info', 'danger'];
    for (const [key, label] of Object.entries(PART_EVENT_LABEL)) {
      expect(label.trim(), `${key} 的中文为空`).not.toBe('');
      expect(TAGS, `${key} 的 tag 非法`).toContain(PART_EVENT_TAG_TYPE[key as PartEventType]);
    }
  });

  it('易混项全部保留：RETURNED / RETURNED_TO_SHELF / RECEIVED_TO_INSPECTION / DELIVERED', () => {
    // RETURNED 是 Python 时代的历史 event_type 字面量（生产库仍有存量行）；
    // RETURNED_TO_SHELF 是 Rust 侧现行写侧。两者语义相同但都必须在册。
    expect(PART_EVENT_LABEL.RETURNED).toBe('归还');
    expect(PART_EVENT_LABEL.RETURNED_TO_SHELF).toBe('归还');
    // 2026-10-10 起后端已停写，保留只为读存量历史行
    expect(PART_EVENT_LABEL.RECEIVED_TO_INSPECTION).toBe('外协回收送检');
    // 事件类型 DELIVERED（t_part_event）≠ 订单状态 DELIVERED（t_part.status）
    expect(PART_EVENT_LABEL.DELIVERED).toBe('已送货');
  });

  it('SCAN_EVENT_TYPE_OPTIONS 仍是 action 三选一，且每项都在两张表里登记', () => {
    // ⚠️ 这是「用户能在扫码台手动选的 action」，不是事件全集：2026-10-17 补齐的
    // 12 条是服务端派生事件，刻意不在其中。
    expect(SCAN_EVENT_TYPE_OPTIONS).toEqual(['PICKED_UP', 'RETURNED', 'INSPECTED']);
    for (const t of SCAN_EVENT_TYPE_OPTIONS) {
      expect(PART_EVENT_LABEL[t], `${t} 不在 PART_EVENT_LABEL 里`).toBeTruthy();
      expect(PART_EVENT_TAG_TYPE[t], `${t} 不在 PART_EVENT_TAG_TYPE 里`).toBeTruthy();
    }
  });

  // ⚠️ 三条「送检」是三个不同的后端写侧，且其中两条会**同框**出现在同一条时间线上：
  //   工人报工台送检（SENT_TO_INSPECTION，唯一计工人工时的那一支）→ 品检打回
  //   （INSPECTION_FAILED）→ 回生产 → 品检页再送检（INSPECTED）。
  // 用户在时间线上分不清哪一条计了工时，正是需求 3 引入这个区分点的理由。
  //
  // 钉死的是「三条 label 互不相同」这条不变量：**不许**把 `SENT_TO_INSPECTION` 改回
  // 逐字等于 `INSPECTED` 的「送检」。tag 错开是**解法之外**的（改 warning 会与
  // `FORCED_SENT_TO_INSPECTION` 撞色），所以这里只查文案。
  it('三条「送检」事件的 label 互不相同（工人主动 / 品检页 / 品检代工人）', () => {
    expect(PART_EVENT_LABEL.SENT_TO_INSPECTION).toBe('工人送检');
    expect(PART_EVENT_LABEL.INSPECTED).toBe('送检');
    expect(PART_EVENT_LABEL.FORCED_SENT_TO_INSPECTION).toBe('强制送检');
    expect(PART_EVENT_LABEL.SENT_TO_INSPECTION).not.toBe(PART_EVENT_LABEL.INSPECTED);
    expect(PART_EVENT_LABEL.SENT_TO_INSPECTION).not.toBe(
      PART_EVENT_LABEL.FORCED_SENT_TO_INSPECTION,
    );
    expect(PART_EVENT_LABEL.INSPECTED).not.toBe(PART_EVENT_LABEL.FORCED_SENT_TO_INSPECTION);
    // 三条都含「送检」二字（同框时一眼认出是同一族动作），区分靠的是前面的主语 / 修饰。
    for (const t of ['SENT_TO_INSPECTION', 'INSPECTED', 'FORCED_SENT_TO_INSPECTION'] as const) {
      expect(PART_EVENT_LABEL[t]).toContain('送检');
    }
  });

  // 全表层面的弱形式不变量：**不得有两条事件共用同一句中文**（否则时间线上用户分不出
  // 哪条是哪条 —— 本轮 MINOR-1 就是这么发生的）。当前**只有一组**合法重复，且必须
  // 逐对点名豁免；出现第二组就是新的文案撞车。
  it('除已点名豁免的一组同义对外，PART_EVENT_LABEL 无重复中文', () => {
    /** 语义真同、允许逐字相同的一组。`RETURNED` 是 Python 时代的历史字面量，
     *  生产库仍有存量行，不能为了「错开」去改它的既有文案（见 `parts.ts` 易混①）。 */
    const ALLOWED_DUPLICATES: Array<[PartEventType, PartEventType]> = [
      ['RETURNED', 'RETURNED_TO_SHELF'],
    ];
    const byLabel = new Map<string, PartEventType[]>();
    for (const [key, label] of Object.entries(PART_EVENT_LABEL) as Array<[PartEventType, string]>) {
      const bucket = byLabel.get(label) ?? [];
      bucket.push(key);
      byLabel.set(label, bucket);
    }
    const duplicates = [...byLabel.entries()].filter(([, keys]) => keys.length > 1);
    const allowedPairs = ALLOWED_DUPLICATES.map(([a, b]) => [a, b].sort().join('|'));
    for (const [label, keys] of duplicates) {
      expect(
        allowedPairs,
        `「${label}」被 ${keys.join(' / ')} 共用；要么改其中一条的中文，要么先在此点名豁免并说明理由`,
      ).toContain([...keys].sort().join('|'));
    }
  });
});
