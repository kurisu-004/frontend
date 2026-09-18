// composables/useUploadSession.ts
//
// 2026-09-18 新增：upload session pool 管理 composable（backend-rust 共享 STS）。
//
// 取代旧的「每文件一次 grantStsTmpKey」模式（python STS 端口，单端口 1-key
// 响应）。新端点对 (scope, batch) 一次性签发 1 个 STS 凭证 + 多个 tmp_key，
// 凭证在 expired_time - 5min 时由本 composable 自动续期。
//
// 模块级单例（CLAUDE.md §硬约束 #1：「跨路由全局状态仍一律模块级单例模式」）：
// - parts/new 两个 Tab（PDF / 录入）共享同一 `parts_new` scope session；
// - 通过 `getUploadSession(scope)` 工厂拿单例；同一 scope 多次调用得到同一实例。
//
// 主要 API：
// - `init(scope)` —— get-or-create session + 启动 renew 定时器
// - `allocate(files)` —— 批量签 tmp_key
// - `markComplete(clientRef, etag?, fileSize?)` —— 上传完成回调
// - `removeFiles(clientRefs)` —— 用户取消 / 失败清理
// - `consumeFiles(clientRefs)` —— batch 提交成功后续期 tmp
// - `discard()` —— 主动销毁整个 session
// - `renew()` —— 手动续期（被自动定时器调用）
// - `getUploadSession(scope)` —— 工厂（跨 Tab 共享单例）
//
// 响应式：
// - `session`：Ref<UploadSession | null>（init 后非空）
// - `credentials`：ComputedRef<StsCredentials | null>
// - `files`：ComputedRef<SessionFile[]>
// - `bucket` / `region` / `tmpPrefix`：ComputedRef<string | null>
//
// 已知约束：
// - renew 定时器：基于 `setTimeout` + `expired_time - 5min` 单次定时，到期
//   自动 renew 并重启定时器；不在 renew 定时器里 polling。
// - 凭证过期检测公式 `(Date.now() + 5 * 60_000) >= expired_time * 1000` 与
//   useCosUpload / useCosUploader 完全对齐（详见 cos-upload.md §5.2）。
// - 不依赖 Vue 组件实例：模块级 setup + 闭包 + watchEffect；可脱离组件
//   直接调用（单测 / 其它 composable 嵌套）。

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type {
  AllocateUploadSessionFileIn,
  AllocateUploadSessionFileOut,
  SessionFile,
  UploadScope,
  UploadSession,
} from '@/types/upload_session';
import {
  allocateUploadSessionFiles,
  completeUploadSessionFile,
  consumeUploadSessionFiles,
  discardUploadSession,
  getOrCreateUploadSession,
  removeUploadSessionFiles,
  renewUploadSessionCredentials,
} from '@/api/files/uploadSession';

/** 凭证过期提前量：到期前 5 分钟触发 renew。 */
const EXPIRY_AHEAD_MS = 5 * 60_000;
/** renew 失败时的退避时间（30s 后重试，避免紧密循环）。 */
const RENEW_RETRY_MS = 30_000;

export interface UseUploadSessionReturn {
  /** 当前 session（init 后非空；discard 后回到 null）。 */
  session: Ref<UploadSession | null>;
  /** 当前 STS 凭证（session 顶层 credentials 字段）。 */
  credentials: ComputedRef<UploadSession['credentials'] | null>;
  /** 当前 bucket / region / tmpPrefix（session 顶层）。 */
  bucket: ComputedRef<string | null>;
  region: ComputedRef<string | null>;
  tmpPrefix: ComputedRef<string | null>;
  /** 当前所有 file 条目（计算属性，与 session.value.files 同源）。 */
  files: ComputedRef<SessionFile[]>;
  /** 当前 scope（init 后非空）。 */
  scope: Ref<UploadScope | null>;

  /** 是否已初始化（init 调用成功）。 */
  isReady: ComputedRef<boolean>;

  /** 申请或获取当前 scope 的 session（幂等）。 */
  init: (scope: UploadScope) => Promise<UploadSession>;
  /** 批量签 tmp_key：files[i].client_ref 由 caller 决定，返回对应 tmp_key。 */
  allocate: (files: AllocateUploadSessionFileIn[]) => Promise<AllocateUploadSessionFileOut[]>;
  /** 标记单个 file 上传完成（PUT 到 tmp 成功后调）。返回更新后的 SessionFile。 */
  markComplete: (clientRef: string, etag?: string, fileSize?: number) => Promise<SessionFile>;
  /** 批量移除 file（用户取消 / 上传失败后清理）。 */
  removeFiles: (clientRefs: string[]) => Promise<string[]>;
  /** 标记 file 已消费（batch 提交成功后调，延长 tmp 保留窗）。 */
  consumeFiles: (clientRefs: string[]) => Promise<string[]>;
  /** 销毁整个 session + 清理本地 state + 取消 renew 定时器。 */
  discard: () => Promise<void>;
  /** 手动续期（通常由内部定时器自动触发；暴露给 useCosUpload 的 refetchIntents）。 */
  renew: () => Promise<void>;
}

/**
 * 单个 scope 的 session 管理器（内部类，外部不直接 import）。
 *
 * 模块级 Map 缓存（scope → UseUploadSessionScopeState）实现「同一 scope
 * 多次 getUploadSession 拿到同一单例」。discard 后从 Map 删除，下次
 * getUploadSession(scope) 重新构造。
 */
interface ScopeState {
  session: Ref<UploadSession | null>;
  scope: Ref<UploadScope | null>;
  renewTimer: ReturnType<typeof setTimeout> | null;
  renewing: boolean;
}

const scopeStates = new Map<UploadScope, ScopeState>();

/** 取消 renew 定时器（幂等）。 */
function clearRenewTimer(state: ScopeState): void {
  if (state.renewTimer !== null) {
    clearTimeout(state.renewTimer);
    state.renewTimer = null;
  }
}

/** 计算下一次 renew 触发时间（ms）：`expired_time * 1000 - now - EXPIRY_AHEAD_MS`。 */
function msUntilNextRenew(expiredTimeSec: number, nowMs: number): number {
  return expiredTimeSec * 1000 - nowMs - EXPIRY_AHEAD_MS;
}

/** 安排下一次 renew：在 expired_time - 5min 触发，到期后调 renew() 续期。 */
function scheduleRenew(state: ScopeState): void {
  clearRenewTimer(state);
  const s = state.session.value;
  if (!s) return;
  const delay = msUntilNextRenew(s.credentials.expired_time, Date.now());
  if (delay <= 0) {
    // 已经过期 → 立即触发
    void doRenew(state).catch(() => {
      /* 内部已设退避定时器；这里吞掉未捕获 rejection */
    });
    return;
  }
  state.renewTimer = setTimeout(() => {
    void doRenew(state).catch(() => {
      /* 内部已设退避定时器；这里吞掉未捕获 rejection */
    });
  }, delay);
}

/**
 * 实际执行 renew：调 renewUploadSessionCredentials → 写回 session.credentials
 * → 重启定时器。失败时设置 30s 退避重试，避免 401/网络抖动导致紧密循环。
 */
async function doRenew(state: ScopeState): Promise<void> {
  if (state.renewing) return;
  const s = state.session.value;
  if (!s) return;
  state.renewing = true;
  try {
    const out = await renewUploadSessionCredentials(s.session_id, { scope: s.scope });
    if (state.session.value) {
      // 仅当 session 未被 discard 时写回（discard 在 await 期间可能已清空）
      state.session.value = {
        ...state.session.value,
        credentials: out.credentials,
        expires_in: out.expires_in,
      };
    }
    scheduleRenew(state);
  } catch {
    // 续期失败 → 30s 后重试；不清空 session，让上层 caller 决定怎么处理
    // （多数情况是临时网络抖动，下次会成功；持续失败由 caller 兜底 discard）。
    state.renewTimer = setTimeout(() => {
      void doRenew(state).catch(() => {
        /* swallow */
      });
    }, RENEW_RETRY_MS);
  } finally {
    state.renewing = false;
  }
}

/**
 * scope → state 工厂：Map 命中复用，未命中新建。
 *
 * 同时绑定「session 变化时自动重启 renew 定时器」（如 renew 成功后
 * session.value 替换，scheduleRenew 内部已重排；这里再 watch 一层覆盖
 * 初次 init 后还没 scheduleRenew 的场景）。
 */
function getOrCreateScopeState(scope: UploadScope): ScopeState {
  const existing = scopeStates.get(scope);
  if (existing) return existing;
  const sessionRef = ref<UploadSession | null>(null) as Ref<UploadSession | null>;
  const scopeRef = ref<UploadScope | null>(null) as Ref<UploadScope | null>;
  const state: ScopeState = {
    session: sessionRef,
    scope: scopeRef,
    renewTimer: null,
    renewing: false,
  };
  scopeStates.set(scope, state);
  return state;
}

/**
 * 工厂入口：获取/构造指定 scope 的 session 管理器。
 *
 * 同一 scope 多次调用返回同一实例（实现两个 Tab 共享同一 session）；
 * discard 后下次调用会拿到新实例（旧 state 从 Map 删除）。
 */
export function getUploadSession(scope: UploadScope): UseUploadSessionReturn {
  const state = getOrCreateScopeState(scope);

  const credentials = computed(() => state.session.value?.credentials ?? null);
  const bucket = computed(() => state.session.value?.bucket ?? null);
  const region = computed(() => state.session.value?.region ?? null);
  const tmpPrefix = computed(() => state.session.value?.tmp_prefix ?? null);
  const files = computed<SessionFile[]>(() => state.session.value?.files ?? []);
  const isReady = computed(() => state.session.value !== null);

  /**
   * 申请或获取 session：Map 命中且未 discard → 复用旧 session（同步返回）；
   * 未命中或已 discard → 调 get-or-create。
   *
   * 复用场景：用户切回本页面 / 两个 Tab 都 init 时只签一次。
   */
  async function init(targetScope: UploadScope): Promise<UploadSession> {
    state.scope.value = targetScope;
    const cur = state.session.value;
    if (cur && cur.scope === targetScope) {
      // 已存在 → 检查凭证是否健康；不健康也直接 renew（避免初次 upload 撞临期）
      const msLeft = cur.credentials.expired_time * 1000 - Date.now();
      if (msLeft <= EXPIRY_AHEAD_MS) {
        await doRenew(state);
      } else {
        scheduleRenew(state);
      }
      return state.session.value!;
    }
    const sess = await getOrCreateUploadSession({ scope: targetScope });
    state.session.value = sess;
    scheduleRenew(state);
    return sess;
  }

  /**
   * 批量签 tmp_key：把 caller 传入的 files 整包给后端；
   * 响应回填到 session.files（按 client_ref 索引，命中即更新 / 未命中即 push）。
   */
  async function allocate(
    incoming: AllocateUploadSessionFileIn[],
  ): Promise<AllocateUploadSessionFileOut[]> {
    const cur = state.session.value;
    if (!cur) throw new Error('upload session 未初始化，请先调 init(scope)');
    const out = await allocateUploadSessionFiles(cur.session_id, {
      scope: cur.scope,
      files: incoming,
    });
    // 把响应回填到 session.files：按 client_ref 匹配；未命中则 push
    const existingByRef = new Map(cur.files.map((f) => [f.client_ref, f]));
    const nextFiles: SessionFile[] = [...cur.files];
    for (const alloc of out.items) {
      const prev = existingByRef.get(alloc.client_ref);
      if (prev) {
        // tmp_key 可能由后端改写 → 用新值；其它字段保留（status 仍 pending）
        const idx = nextFiles.findIndex((f) => f.client_ref === alloc.client_ref);
        if (idx >= 0) nextFiles[idx] = { ...prev, tmp_key: alloc.tmp_key };
      } else {
        // allocate 响应回填一个新条目：构造完整 SessionFile
        const inItem = incoming.find((f) => f.client_ref === alloc.client_ref);
        if (inItem) {
          nextFiles.push({
            client_ref: alloc.client_ref,
            kind: inItem.kind,
            original_filename: inItem.original_filename,
            file_size: inItem.file_size,
            content_type: inItem.content_type,
            content_sha256: inItem.content_sha256,
            tmp_key: alloc.tmp_key,
            status: 'pending',
            etag: null,
            uploaded_at: null,
          });
        }
      }
    }
    state.session.value = { ...cur, files: nextFiles };
    return out.items;
  }

  /**
   * 标记单个 file 上传完成：调 completeUploadSessionFile 拿到更新后的
   * SessionFile，原子替换 session.files 中对应条目。
   */
  async function markComplete(
    clientRef: string,
    etag?: string,
    fileSize?: number,
  ): Promise<SessionFile> {
    const cur = state.session.value;
    if (!cur) throw new Error('upload session 未初始化');
    const payload: { scope: UploadScope; etag?: string; file_size?: number } = {
      scope: cur.scope,
    };
    if (etag !== undefined) payload.etag = etag;
    if (fileSize !== undefined) payload.file_size = fileSize;
    const updated = await completeUploadSessionFile(cur.session_id, clientRef, payload);
    const nextFiles = cur.files.map((f) => (f.client_ref === clientRef ? updated : f));
    state.session.value = { ...cur, files: nextFiles };
    return updated;
  }

  /**
   * 批量移除 file：调 removeUploadSessionFiles；同步本地 session.files
   * （按后端返回的 `removed` 列表过滤）。
   */
  async function removeFiles(clientRefs: string[]): Promise<string[]> {
    const cur = state.session.value;
    if (!cur) throw new Error('upload session 未初始化');
    if (clientRefs.length === 0) return [];
    const out = await removeUploadSessionFiles(cur.session_id, {
      scope: cur.scope,
      client_refs: clientRefs,
    });
    const removedSet = new Set(out.removed);
    const nextFiles = cur.files.filter((f) => !removedSet.has(f.client_ref));
    state.session.value = { ...cur, files: nextFiles };
    return out.removed;
  }

  /**
   * 标记 file 已消费：batch 提交成功后调；不影响 status（仍是 done），
   * 仅延长 tmp 对象保留窗口。失败不影响前端状态（best-effort）。
   */
  async function consumeFiles(clientRefs: string[]): Promise<string[]> {
    const cur = state.session.value;
    if (!cur) return [];
    if (clientRefs.length === 0) return [];
    const out = await consumeUploadSessionFiles(cur.session_id, {
      scope: cur.scope,
      client_refs: clientRefs,
    });
    return out.consumed;
  }

  /**
   * 销毁整个 session：调 discardUploadSession → 清空本地 state → 取消
   * renew 定时器 → 从 scopeStates Map 删除（下次 getUploadSession 拿到
   * 新实例，避免老 state 复活）。
   */
  async function discard(): Promise<void> {
    const cur = state.session.value;
    if (!cur) return;
    clearRenewTimer(state);
    try {
      await discardUploadSession(cur.session_id, { scope: cur.scope });
    } finally {
      state.session.value = null;
      state.scope.value = null;
      scopeStates.delete(cur.scope);
    }
  }

  /** 手动 renew：暴露给 caller（如 useCosUpload refetchIntents）。 */
  async function renew(): Promise<void> {
    await doRenew(state);
  }

  return {
    session: state.session,
    credentials,
    bucket,
    region,
    tmpPrefix,
    files,
    scope: state.scope,
    isReady,
    init,
    allocate,
    markComplete,
    removeFiles,
    consumeFiles,
    discard,
    renew,
  };
}
