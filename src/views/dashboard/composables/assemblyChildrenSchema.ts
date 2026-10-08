// 2026-10-10 新增：dashboard 装配件子件列表的守门 schema。
//
// 守门对象是**从 `GET /api/v2/assemblies/{id}` 的 `children[]` 里裁出的最小结构**
// （装配体详情端点零新增后端端点即可供数），字段集对齐子件弹窗表格的 5 列
// （序列号 / 名称 / 数量 / 状态 / 系统交期）+ 点行预览需要的 id：
//
//   - status 复用 OrderStatus 枚举（子件是 t_part 行，与装配体详情 VO 的 status 同源）；
//   - system_delivery_date 可空（t_part 该列可空，弹窗按 '—' 兜底，不参与紧迫配色）。
//
// ⚠️ **已交量不在这份 schema 里**：弹窗表格刻意不显示已交量（装配件的部分已交是
// **套级**口径，子件级已交量与之不同源、也不同单位，摆进来会被读成可加总的同类数）。

import { z } from 'zod';
import { ORDER_STATUSES } from '@/types/parts';

export const assemblyChildRowSchema = z.object({
  id: z.string(),
  serial_no: z.string().nullable(),
  name: z.string(),
  quantity: z.number(),
  status: z.enum(ORDER_STATUSES),
  system_delivery_date: z.string().nullable(),
});

export type AssemblyChildRowData = z.infer<typeof assemblyChildRowSchema>;
