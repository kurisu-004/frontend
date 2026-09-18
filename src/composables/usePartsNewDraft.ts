// composables/usePartsNewDraft.ts
//
// 2026-09-18 新增：parts/new 页面 localStorage 草稿快照。
//
// 背景：upload_session 引入后，后端在「用户上传完图纸 → 提交 batchCreateParts」
// 之间形成了一个长链条（allocate → COS PUT → complete → batch create）。
// 若用户中途刷新 / 切换 Tab / 离开页面再回来，前端内存 state 全丢，session
// 中的 tmp 对象虽然还在 COS tmp 区，但 rows / staged 等 UI 数据没了。
//
// 本 composable 把「可序列化子集」持久化到 localStorage，mount 时与 upload
// session.files 按 client_ref + sha256 合并，恢复工作现场：
// - session.files[i].status='done' → 行直接恢复「已上传」态（UI 不弹需重传）
// - session.files 缺该 client_ref → 行数据保留，UI 标「需重新选择该文件」
// - session.files 存在但不在快照里 → 列在源文件区供用户认领（罕见）
//
// localStorage key 约定：`parts_new:draft:{user_id}` —— 含 user_id 避免
// 共享浏览器账号污染（与 useColumnVisibility.storageKey 同模式）。
//
// 写入时机：
// - mount 后所有初始化完成 → 写一次「baseline」快照（rows/staged 为空）；
// - 行 / 树 / staged 变更后 → debounce 500ms 写一次；
// - 「提交成功」与「discard」时清空。
//
// 读取时机：
// - mount 时（usePartBatchPdf / usePartBatchManual 各自调 `loadDraft(userId)`）。
//
// 测试覆盖：序列化往返 + 合并逻辑（mock session）。

import { useAuthSession } from '@/composables/useAuthSession';
import type { SessionFile, UploadSession } from '@/types/upload_session';

// ============================================================
// 序列化类型（与后端契约对齐：version=1 即可）
// ============================================================

/** 独立零件行的可序列化子集（pdfSourceUid / File 不存）。 */
export interface SerializedStandalonePartRow {
  uid: string;
  pdfSourceUid: string;
  pageCount: number;
  mergedFrom?: { pdfUid: string; pageIndex: number }[];
  drawing_no: string;
  name: string;
  applicant_name: string;
  customer_id: string;
  customer_name: string;
  request_date: string;
  planned_delivery_date: string;
  system_delivery_date: string | null;
  order_no: string | null;
  note: string | null;
  is_urgent: boolean;
  quantity: number;
  unit_price: number | null;
  total_price: number | null;
  three_d_index: number | null;
  /** 关联的图纸 client_ref（来自 session.allocate）。 */
  drawing_client_ref?: string;
  drawing_sha256?: string;
  /** 关联的 3D 模型 client_ref。 */
  three_d_client_ref?: string;
  three_d_sha256?: string;
}

/** 装配件子件的可序列化子集。 */
export interface SerializedAssemblyChildRow {
  uid: string;
  pdfSourceUid: string;
  page_index: number;
  drawing_no: string;
  name: string;
  quantity: number;
  is_urgent: boolean;
  request_date: string;
  planned_delivery_date: string;
  system_delivery_date: string | null;
  order_no: string | null;
  note: string | null;
  unit_price: number | null;
  total_price: number | null;
  three_d_index: number | null;
  drawing_client_ref?: string;
  drawing_sha256?: string;
  three_d_client_ref?: string;
  three_d_sha256?: string;
}

/** 装配件顶层的可序列化子集。 */
export interface SerializedAssemblyRow {
  uid: string;
  pdfSourceUid: string;
  drawing_no: string;
  name: string;
  applicant_name: string;
  customer_id: string;
  customer_name: string;
  request_date: string;
  planned_delivery_date: string;
  system_delivery_date: string | null;
  order_no: string | null;
  note: string | null;
  is_urgent: boolean;
  masterPageIndex: number | null;
  quantity: number;
  drawing_client_ref?: string;
  drawing_sha256?: string;
  children: SerializedAssemblyChildRow[];
}

/** 手工录入 Tab 待新增条目的可序列化子集（File / blob URL 不存）。 */
export interface SerializedStagedEntry {
  uid: string;
  drawingNo: string;
  name: string;
  applicantName: string;
  applicantId: string | null;
  customerId: string | null;
  customerLabel: string;
  quantity: number;
  isUrgent: boolean;
  requestDate: string;
  plannedDeliveryDate: string;
  orderNo: string | null;
  systemDeliveryDate: string | null;
  note: string | null;
  /** 图纸 binding（FileBinding shape）—— 不依赖 session；下次提交时仍可走 confirm 链路。 */
  drawingTmpKey?: string;
  drawingSha256?: string;
  drawingFilename?: string;
  drawingFileSize?: string;
  drawingContentType?: string;
  /** 关联的 client_ref（来自 session.allocate）。 */
  drawingClientRef?: string;
}

/** 列宽 / 列序快照（最小可序列化形状，组件层如有需要再扩展）。 */
export interface SerializedColumnLayout {
  /** 列显示顺序（key 数组）。 */
  order?: string[];
  /** 列可见性 map（key → boolean）。 */
  visibility?: Record<string, boolean>;
  /** 列宽 map（key → px 数字）。 */
  widths?: Record<string, number>;
}

/** PDF Tab 完整快照。 */
export interface SerializedPdfTab {
  customerL1Id: string | null;
  requestDate: string;
  rows: SerializedStandalonePartRow[];
  assemblies: SerializedAssemblyRow[];
  selectedPages: string[];
  /** 文件上传关联（drawing + 3D → rows / child）。 */
  file_links: Array<{
    client_ref: string;
    sha256: string;
    /** 该 file 关联到哪些 row uid（standalone / asmMaster / asmChild）。 */
    bound_row_ids: string[];
    kind: 'drawing' | '3d_model';
  }>;
  column_layout?: SerializedColumnLayout;
}

/** 手工录入 Tab 完整快照。 */
export interface SerializedManualTab {
  staged: SerializedStagedEntry[];
  form_draft?: unknown;
}

/** 草稿快照根结构（localStorage JSON 形态）。 */
export interface PartsNewDraftPayload {
  version: 1;
  user_id: string;
  saved_at: string;
  active_tab: 'manual' | 'pdf';
  pdf_tab: SerializedPdfTab;
  manual_tab: SerializedManualTab;
}

// ============================================================
// 合并结果类型（caller 据此更新 UI）
// ============================================================

/** 合并后单行 file 状态。 */
export type MergedFileStatus =
  | 'done' // session.files 命中 + status=done → 行直接恢复「已上传」
  | 'need_reselect'; // session.files 缺该 client_ref 或 status≠done → 需重选

/**
 * 合并后独立零件行（pdfRows[i]）。
 *
 * 2026-09-18 收窄：原 MergedRow 把三种 row 类型 union 在一个 row 字段，
 * caller 端 deserialize 时做类型断言；本次拆成三个具名 interface + 三个
 * 数组元素类型，让 TS 编译期挡错。
 */
export interface MergedStandaloneRow {
  row: SerializedStandalonePartRow;
  drawing: MergedFileStatus | undefined;
  threeD: MergedFileStatus | undefined;
}

/** 合并后装配件子件行。 */
export interface MergedAssemblyChildRow {
  row: SerializedAssemblyChildRow;
  drawing: MergedFileStatus | undefined;
  threeD: MergedFileStatus | undefined;
}

/** 合并后装配件顶层行 + 其下所有子件（master 用 children[0]，其余是 child）。 */
export interface MergedAssembly {
  row: SerializedAssemblyRow;
  children: Array<MergedAssemblyChildRow | MergedStandaloneRowLike>;
}

/**
 * MergedAssembly.children 元素联合（master 在 [0]，child 在 [1..]）。
 * master 只关心 drawing 字段，无 threeD。
 */
export interface MergedStandaloneRowLike {
  row: SerializedStandalonePartRow | SerializedAssemblyRow | SerializedAssemblyChildRow;
  drawing: MergedFileStatus | undefined;
  threeD?: MergedFileStatus | undefined;
}

/** 合并后 staging 条目（手工录入 Tab）。 */
export interface MergedStaged {
  entry: SerializedStagedEntry;
  drawing: MergedFileStatus | undefined;
}

/** 合并结果。 */
export interface MergeResult {
  pdfRows: MergedStandaloneRow[];
  pdfAssemblies: MergedAssembly[];
  manualStaged: MergedStaged[];
  /** session.files 存在但不在快照里的 client_refs（用于「源文件区待认领」展示）。 */
  orphanFileRefs: SessionFile[];
  /** 是否真的从草稿恢复（false = 草稿缺失 / 版本不匹配 / user_id 不匹配）。 */
  restored: boolean;
}

// ============================================================
// 纯函数：合并 draft 与 session.files
// ============================================================

/**
 * 把 draft 与 upload session.files 按 client_ref + sha256 合并：
 * - 命中 + done → 'done'
 * - 命中 + 其它 / 未命中 → 'need_reselect'
 *
 * 不依赖 Vue / localStorage / API，方便单测直接调用。
 *
 * @param draft 读到的 draft 快照（可能为 null）
 * @param session 当前 upload session（可能为 null）
 */
export function mergeDraftWithSession(
  draft: PartsNewDraftPayload | null,
  session: UploadSession | null,
): MergeResult {
  if (!draft) {
    return {
      pdfRows: [],
      pdfAssemblies: [],
      manualStaged: [],
      orphanFileRefs: session?.files ?? [],
      restored: false,
    };
  }

  const files = session?.files ?? [];
  const byRef = new Map(files.map((f) => [f.client_ref, f]));

  const classifyFile = (clientRef: string | undefined): MergedFileStatus | undefined => {
    if (!clientRef) return undefined;
    const f = byRef.get(clientRef);
    if (!f) return 'need_reselect';
    return f.status === 'done' ? 'done' : 'need_reselect';
  };

  const pdfRows: MergedStandaloneRow[] = draft.pdf_tab.rows.map((row) => ({
    row,
    drawing: classifyFile(row.drawing_client_ref),
    threeD: classifyFile(row.three_d_client_ref),
  }));

  const pdfAssemblies: MergedAssembly[] = draft.pdf_tab.assemblies.map((a) => {
    const master: MergedStandaloneRowLike = {
      row: a,
      drawing: classifyFile(a.drawing_client_ref),
      threeD: undefined,
    };
    const children: MergedAssemblyChildRow[] = a.children.map((c) => ({
      row: c,
      drawing: classifyFile(c.drawing_client_ref),
      threeD: classifyFile(c.three_d_client_ref),
    }));
    return { row: a, children: [master, ...children] };
  });

  const manualStaged: MergedStaged[] = draft.manual_tab.staged.map((s) => ({
    entry: s,
    drawing: classifyFile(s.drawingClientRef),
  }));

  // orphan：session.files 存在但不在 snapshot.file_links 引用集合里
  const referencedRefs = new Set<string>();
  draft.pdf_tab.file_links.forEach((l) => referencedRefs.add(l.client_ref));
  draft.pdf_tab.rows.forEach((r) => {
    if (r.drawing_client_ref) referencedRefs.add(r.drawing_client_ref);
    if (r.three_d_client_ref) referencedRefs.add(r.three_d_client_ref);
  });
  draft.pdf_tab.assemblies.forEach((a) => {
    if (a.drawing_client_ref) referencedRefs.add(a.drawing_client_ref);
    a.children.forEach((c) => {
      if (c.drawing_client_ref) referencedRefs.add(c.drawing_client_ref);
      if (c.three_d_client_ref) referencedRefs.add(c.three_d_client_ref);
    });
  });
  draft.manual_tab.staged.forEach((s) => {
    if (s.drawingClientRef) referencedRefs.add(s.drawingClientRef);
  });
  const orphanFileRefs = files.filter((f) => !referencedRefs.has(f.client_ref));

  return {
    pdfRows,
    pdfAssemblies,
    manualStaged,
    orphanFileRefs,
    restored: true,
  };
}

// ============================================================
// localStorage 读写
// ============================================================

/** 当前草稿快照 schema 版本；不匹配 → 丢弃。 */
const DRAFT_VERSION = 1;

/** 构造 localStorage key：含 user_id 后缀，避免共享浏览器账号污染。 */
export function draftStorageKey(userId: string): string {
  return `parts_new:draft:${userId}`;
}

/**
 * 从 localStorage 读取草稿。
 *
 * 校验规则：
 * - user_id 必须等于当前 user.id（雪花 ID 字符串比对）；
 * - version 必须等于 DRAFT_VERSION；
 * - 结构必须满足 PartsNewDraftPayload 形状（缺关键字段 → 视为损坏 → 返回 null）。
 *
 * 任何校验失败都返回 null（不会抛错；caller 据此当作「无草稿」处理）。
 */
export function loadDraft(userId: string): PartsNewDraftPayload | null {
  try {
    const raw = localStorage.getItem(draftStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PartsNewDraftPayload | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== DRAFT_VERSION) return null;
    if (parsed.user_id !== userId) return null;
    if (!parsed.pdf_tab || !parsed.manual_tab) return null;
    return parsed;
  } catch {
    /* localStorage 被禁 / 解析失败 → 静默回退到无草稿 */
    return null;
  }
}

/**
 * 写入草稿到 localStorage（带 try/catch 兜底）。
 *
 * 返回 boolean 表示是否成功；调用方一般不关心返回值（写入失败仅丢草稿，
 * 不影响主流程）。
 */
export function saveDraft(
  userId: string,
  payload: Omit<PartsNewDraftPayload, 'version' | 'user_id'>,
): boolean {
  try {
    const full: PartsNewDraftPayload = {
      ...payload,
      version: DRAFT_VERSION,
      user_id: userId,
    };
    localStorage.setItem(draftStorageKey(userId), JSON.stringify(full));
    return true;
  } catch {
    /* quota exceeded / disabled → 静默吞 */
    return false;
  }
}

/** 清空草稿（提交成功 / discard 时调）。 */
export function clearDraft(userId: string): void {
  try {
    localStorage.removeItem(draftStorageKey(userId));
  } catch {
    /* swallow */
  }
}

/**
 * debounce 工厂：500ms 内的连续调用合并为最后一次执行（返回的函数带 .flush()
 * / .cancel() 控制）。caller 在组件 setup 阶段 new 一次，挂到 watch 上即可。
 */
export function createDraftSaver(
  userId: string,
  delayMs = 500,
): {
  schedule: (payload: Omit<PartsNewDraftPayload, 'version' | 'user_id'>) => void;
  cancel: () => void;
  flush: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Omit<PartsNewDraftPayload, 'version' | 'user_id'> | null = null;

  function fire(): void {
    if (pending) {
      saveDraft(userId, pending);
      pending = null;
    }
    timer = null;
  }

  return {
    schedule(payload) {
      pending = payload;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(fire, delayMs);
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
    flush() {
      fire();
    },
  };
}

/**
 * 工厂入口：组件 setup 内调用，返回 `{ load, save, clear, saver, userId }`。
 *
 * - `saver` 是 debounced writer，挂到 watch 上即可自动保存；
 * - `userId` 从 useAuthSession 取（雪flake ID 字符串）；
 * - 鉴权未就绪（userId 为 null）时所有操作静默 no-op（caller 不必额外 guard）。
 */
export function usePartsNewDraft(): {
  load: () => PartsNewDraftPayload | null;
  save: (payload: Omit<PartsNewDraftPayload, 'version' | 'user_id'>) => void;
  clear: () => void;
  saver: ReturnType<typeof createDraftSaver>;
  userId: string | null;
} {
  // useAuthSession 内部维护模块级 user ref；非 setup 上下文调用会抛错，
  // 工厂入口通常在 setup 内被调，不会撞这条分支。
  let userId: string | null = null;
  try {
    const { user } = useAuthSession();
    userId = user.value?.id ?? null;
  } catch {
    /* 非 setup 上下文 → userId 保持 null，所有操作 no-op */
  }

  const saver = createDraftSaver(userId ?? 'anon');

  return {
    userId,
    load: () => (userId ? loadDraft(userId) : null),
    save: (payload) => {
      if (userId) saveDraft(userId, payload);
    },
    clear: () => {
      if (userId) clearDraft(userId);
    },
    saver,
  };
}
