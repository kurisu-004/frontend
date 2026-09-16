/** 工序 (Process) — 零件的加工步骤 */

export type ProcessCategory = 'INHOUSE' | 'OUTSOURCE';

export const PROCESS_CATEGORY_LABEL: Record<ProcessCategory, string> = {
  INHOUSE: '自产',
  OUTSOURCE: '外协',
};

export interface Process {
  id: string;
  /** 乐观锁版本号；每次 UPDATE 自增 */
  version: number;
  code: string;
  name: string;
  category: ProcessCategory;
  sort_order: number;
  description: string | null;
  /**
   * 外协工序是否需要报价审批（2026-07-28 新增）：
   * - true：走原有报价 + MANAGER 审批 + 发送流程（OUTSOURCE 默认）
   * - false：CLERK/INSPECTOR 可在「零件位于 C2 货架」前提下跳过报价直接发送
   * INHOUSE 工序固定为 false（无业务含义，仅占位）。
   */
  requires_approval: boolean;
  /**
   * 2026-09-12 新增：前端工序卡片颜色（hex 含 alpha）。
   * 格式 `#RRGGBBAA`，9 字符（Element Plus `el-color-picker color-format="hex8"` 默认输出）。
   * NULL = 未设置（前端视作默认色）。
   * 合并 fc99d3b（required string|null）和 feature/process-design（optional）冲突时，
   * 取 HEAD 的 required 语义：后端始终返回字段（可为 null），前端渲染层视 null 为未设置。
   */
  color: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 2026-09-16 替换：工序卡片配色预设改为标准 8 色彩虹（红→橙→黄→绿→青→蓝→紫→粉），
 * 按 sort_order 顺序循环取用 + el-color-picker 预定义色板。饱和的 Flat UI 调色板
 * 视觉区分度高，便于一眼分辨相邻工序；末尾 alpha = FF 表示完全不透明，
 * 与后端 t_process.color VARCHAR(9) 的 `#RRGGBBAA` 格式兼容（color-format="hex8"）。
 */
export const PROCESS_COLOR_PRESETS: readonly string[] = [
  '#E74C3CFF', // 红
  '#F39C12FF', // 橙
  '#F1C40FFF', // 黄
  '#2ECC71FF', // 绿
  '#1ABC9CFF', // 青
  '#3498DBFF', // 蓝
  '#9B59B6FF', // 紫
  '#FF69B4FF', // 粉（补充色，让预设覆盖超过 7 色工序仍可循环区分）
] as const;

export interface ProcessListResult {
  items: Process[];
  total: number;
  limit: number;
  offset: number;
}

export interface ProcessCreatePayload {
  code: string;
  name: string;
  category: ProcessCategory;
  sort_order?: number;
  description?: string | null;
  /** OUTSOURCE 默认 true；INHOUSE 由后端强制覆盖为 false */
  requires_approval?: boolean;
  /** 2026-09-12 新增：工序卡片颜色（hex8 字符串）；不传 = 后端 NULL */
  color?: string | null;
}

export interface ProcessUpdatePayload {
  name?: string;
  category?: ProcessCategory;
  sort_order?: number;
  /**
   * 2026-09-12 新增：三态更新。
   * - undefined：不修改（field omitted → 后端 CASE WHEN 跳过）
   * - null：清除（后端 CASE WHEN true → 设为 NULL）
   * - string：设置新值
   */
  description?: string | null;
  requires_approval?: boolean;
  /** 2026-09-12 新增：颜色三态更新，语义同 description */
  color?: string | null;
}
