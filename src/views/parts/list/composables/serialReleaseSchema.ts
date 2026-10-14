// views/parts/list/composables/serialReleaseSchema.ts
//
// 2026-10-19 新增：`POST /api/v2/serials/release-terminal`（一键释放终态工单占用的
// 序列号）的出参守门 schema。
//
// **为什么放域内**：本端点的唯一消费方是零件一览页工具栏的全局一键入口（`useSerialRelease`
// 的两条 mutation + `SerialReleasePreviewDialog.vue`），与「域 schema 与消费它的 composable
// 同居」同款（照 statistics 域三条 schema 归位的处置）。`src/composables/queries/schemas.ts`
// 只留跨域共用的基础数据层，序列号释放是单域单端点，留在那里既不归属、也会让读代码的
// 人多一次「该 import 哪个路径」的判断。
//
// **为什么 `.strict()`**：这份响应是**逐格渲染给管理员看的回执** —— 三条计数 + 明细表
// 每一格都直接上屏，且它是一次不可撤销的破坏性操作前唯一的告知面。形状漂移时若沿用
// Zod 默认的 strip，多出来的键会被静默丢掉：表少渲染一列而没有任何报错，管理员在确认框
// 里看到的明细与后端实际释放的集合已经不一致 ⇒ 恰好在最需要如实告知的地方说谎。
//
// **为什么 `drawing_no` 必须显式声明 `z.string().nullable()`**：值可空（装配件行未必带图号），
// 键恒在。漏声明 = Zod 默认 strip 静默丢键 ⇒ 组件的 `drawing_no === null` 判定永远不成立，
// 那一格恒渲染成空白且 typecheck / lint 全绿（本仓「漏声明 = 静默降级，不是报错」的典型，
// 同 2026-10-17 客户无限层级那批 `customer_path`）。
//
// 守门点在 mutationFn（`useSerialRelease` 的两条 mutation 各自 parse 一次）；api 层
// `src/api/serial.ts` 只发请求 + 用 `ReleaseTerminalSerialsData` 标注返回类型，不 parse。

import { z } from 'zod';

/** 一条待释放（或已释放）的序列号明细行（后端 `ReleasedSerialItem`）。
 *
 *  `kind` 是判别位：ASSEMBLY = 装配件整单、PART = 零件 / 子件。两侧都是各自表上的
 *  一行（后端两表都清），`id` 是该行主键的雪花 ID 字符串（全程 string，不经 Number()）。 */
export const releasedSerialItemSchema = z.object({
  kind: z.enum(['ASSEMBLY', 'PART']),
  id: z.string(),
  serial_no: z.string(),
  /** ⚠️ **必填键、值可空**（见文件头）：装配件行未必带图号，后端恒下发该键。 */
  drawing_no: z.string().nullable(),
  status: z.string(),
});

/** `POST /serials/release-terminal` 的出参（后端 `ReleaseTerminalSerialsOut`）。
 *
 *  两段式语义：`dry_run: true` 只预览（同一套形状、同一批计数），`dry_run: false` 实跑。
 *  三个计数是**真实总数**，不受明细截断影响 —— 明细被 `RELEASE_DETAIL_LIMIT`（200）截断时
 *  `affected.length < released_total`，界面据此提示「仅显示前 N 条」。 */
export const releaseTerminalSerialsOutSchema = z
  .object({
    dry_run: z.boolean(),
    assembly_count: z.number().int().nonnegative(),
    part_count: z.number().int().nonnegative(),
    /** = assembly_count + part_count；dry_run 时语义是「将释放」。 */
    released_total: z.number().int().nonnegative(),
    truncated: z.boolean(),
    affected: z.array(releasedSerialItemSchema),
  })
  .strict();

/** api 层只取这个派生类型标注返回类型（`import type`，编译期擦除）。 */
export type ReleaseTerminalSerialsData = z.infer<typeof releaseTerminalSerialsOutSchema>;
