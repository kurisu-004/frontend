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
  ['SENT_TO_INSPECTION', '送检', 'primary'],
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
});
