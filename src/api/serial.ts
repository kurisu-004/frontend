// 序列号（工单流水号）API（走 @/api/http 统一 axios 客户端）。
//
// 2026-10-19 新增：只放「一键释放终态工单占用的序列号」这一个端点。文件名取前端实体
// 「序列号」而非后端模块名 —— `src/api/` 是按**前端实体扁平放置**、不按后端模块分层
// （同 `shelves.ts` / `applicant.ts` / `statistics.ts`），所以不塞进 `assembly.ts`：
// 本端点同时改装配件表与零件表，是跨实体的清理动作。
//
// 后端约束：
// - MANAGER-only（handler 层 `require_role(Role::Manager)`）；
// - 入参只有 `dry_run` 一个键，两段式：`true` 预览、`false` 实跑。⚠️ 后端 `dry_run` 带
//   `#[serde(default)]` ⇒ **空 body 等价于实跑**（后端 dto.rs 自称已知风险）；出参又把
//   `dry_run` 原样回显、注释写明「供前端确认这次到底是预览还是实跑」⇒ 消费侧在 apply
//   路径上**真的比一次**回显，不符即报错（`useSerialRelease.ts` 的 applyMutation）；
// - 出参 wire 契约见 `src/views/parts/list/composables/serialReleaseSchema.ts`
//   （域内 Zod 守门 schema，与消费它的 `useSerialRelease` 同居）。
//
// 本文件**只发请求 + 用 schema 的 `*Data` 派生类型标注返回类型，不做 Zod 校验**：
// 守门点在 composable 的 mutationFn（`views/parts/list/composables/useSerialRelease.ts`），
// Zod 的校验入口返回深拷贝，在 api 层再走一遍等于同一份数据被校验并克隆两遍。
// 负向守卫见 `src/api/__tests__/serial.spec.ts`。

import { api } from '@/api/http';
import type { ReleaseTerminalSerialsData } from '@/views/parts/list/composables/serialReleaseSchema';

/** 两段式的入参：形状完全对称，只有 `dry_run` 决定「只报数」还是「真释放」。 */
export interface ReleaseTerminalSerialsPayload {
  dry_run: boolean;
}

/**
 * POST /serials/release-terminal
 *
 * 一键释放**终态**（已完成 / 已取消）工单仍占用的序列号，装配件表与零件 / 子件表两侧都清。
 *
 * - `dry_run: true` —— 只统计不改数据，返回「将释放多少条」+ 明细，供二次确认框展示；
 * - `dry_run: false` —— 在单个事务里实跑，返回真实释放条数 + 明细。
 *
 * ⚠️ 不可撤销：序列号回池后可能被后续新建工单立即复用（后端号池 wrap-around），
 * 零件侧另会为每个被释放的零件落一条 `SERIAL_RELEASED` 归档事件。
 *
 * 明细最多返 `RELEASE_DETAIL_LIMIT`（200）条，三个计数不受截断影响。
 */
export async function releaseTerminalSerials(
  payload: ReleaseTerminalSerialsPayload,
): Promise<ReleaseTerminalSerialsData> {
  const { data } = await api.post<ReleaseTerminalSerialsData>('/serials/release-terminal', payload);
  return data;
}
