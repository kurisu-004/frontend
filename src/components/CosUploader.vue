<!--
  CosUploader.vue

  2026-09-17 新增：通用 COS 上传 UI 组件。

  封装「选文件 → 算 hash（可选）→ 申请 STS 凭证 → 直传 COS → caller confirm」全流程。
  配套：
  - 类型契约 src/types/cos_upload.ts
  - 底层 composable src/composables/useCosUploader.ts
  - 选文件纯函数 src/components/cosUploaderPickPlan.ts

  2026-09-28 整改：el-upload 内部列表泄漏（limit 永久超限）、
              双次 requestUpload（sha256 + allocate 双倍浪费）、
              startUpload 重入竞态、confirm 双调用、allDone payload 语义、
              错误反馈通道统一。

  与 FileListCard.vue 的差异：
  - FileListCard 强绑 part-file 域（PartFileItem / PartFileKind），且走 multipart
    上传到 backend；本组件走 STS 前端直传 COS tmp 区 + caller confirm 两段式
    链路，零业务字段；
  - 本组件自身不 import 任何 part-file / api/parts/delivery-* 域特定模块。
-->
<template>
  <div class="cos-uploader">
    <el-upload
      ref="uploadRef"
      action="#"
      drag
      :multiple="multiple"
      :auto-upload="false"
      :show-file-list="false"
      :accept="accept || undefined"
      :disabled="disabled"
      :on-change="onPick"
    >
      <el-icon class="el-icon--upload"><upload-filled /></el-icon>
      <div class="el-upload__text">拖拽文件到此处，或<em>点击选择</em></div>
      <template v-if="tip || maxSizeMB || accept" #tip>
        <div class="el-upload__tip cos-uploader__tip">
          <span v-if="tip">{{ tip }}</span>
          <span v-if="maxSizeMB" class="cos-uploader__size-hint">
            （最大 {{ maxSizeMB }} MB / 文件）
          </span>
          <span v-if="accept" class="cos-uploader__accept-hint"> （仅接受 {{ accept }}） </span>
        </div>
      </template>
    </el-upload>

    <ul v-if="items.length > 0" class="cos-uploader__list">
      <li v-for="it in items" :key="it.client_ref" class="cos-uploader__row">
        <el-icon class="cos-uploader__icon"><document /></el-icon>
        <div class="cos-uploader__meta">
          <div class="cos-uploader__name" :title="it.file.name">
            {{ it.file.name }}
          </div>
          <div class="cos-uploader__sub">
            <span class="cos-uploader__size">{{ formatSize(it.file.size) }}</span>
            <el-tag v-if="it.status === 'hashing'" size="small" type="info" effect="plain"
              >hash 中…</el-tag
            >
            <el-tag v-else-if="it.status === 'uploading'" size="small" effect="plain"
              >上传中</el-tag
            >
            <el-tag v-else-if="it.status === 'done'" size="small" type="success" effect="plain"
              >✓ 已上传</el-tag
            >
            <el-tag v-else-if="it.status === 'error'" size="small" type="danger" effect="plain"
              >失败</el-tag
            >
            <el-tag v-else size="small" effect="plain">待上传</el-tag>
          </div>
          <el-progress
            v-if="it.status === 'hashing' || it.status === 'uploading'"
            :percentage="it.progress"
            :stroke-width="4"
            :show-text="false"
            class="cos-uploader__progress"
          />
          <span
            v-else-if="it.status === 'error'"
            class="cos-uploader__error-msg"
            :title="it.error"
            >{{ it.error }}</span
          >
        </div>
        <div class="cos-uploader__actions">
          <el-button
            v-if="it.status === 'error'"
            link
            type="primary"
            size="small"
            :loading="!!retryingRefs[it.client_ref]"
            @click="retryItem(it.client_ref)"
            >重试</el-button
          >
          <el-button link type="danger" size="small" @click="removeItem(it.client_ref)"
            >移除</el-button
          >
        </div>
      </li>
    </ul>

    <div v-else class="cos-uploader__empty">
      <el-icon :size="28" color="#c0c4cc"><document-remove /></el-icon>
      <span>{{ emptyText }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 通用 COS 上传 UI 组件（2026-09-17 新增，2026-09-28 整改）。
 *
 * 内部消费 useCosUploader（src/composables/useCosUploader.ts）实现上传状态机；
 * caller 通过 Props 注入业务端点（requestUpload / confirm / cancel），组件自身
 * 零业务字段，零 part-file / delivery-* / api/* 域特定 import。
 *
 * Props / Events / Exposes 见对应 defineProps / defineEmits / defineExpose。
 *
 * 2026-09-28 整改要点（详见文件头注释）：
 * - 删 el-upload 的 :limit / :before-upload / :on-exceed — el-upload 内部列表
 *   泄漏（每选一次 push 一条，cosUploader.removeItem 不清内部列表）导致
 *   :limit 永久超限。改在组件内自实现 limit（planPick）；每次 onPick 立即
 *   clearFiles() 清空内部幽灵列表。
 * - onPick 走 microtask 合批：el-upload 的 on-change 在多文件拖拽 / input
 *   多选时同步触发 N 次。buffer 后 microtask flush 让 N 次合并成一次
 *   requestUpload，根除「首次 onPick 调一次 + 首次 startUpload 兜底又调一次」
 *   的双调浪费（300MB PDF sha256 重算 + 后端 allocate 双份 tmp_key）。
 * - startUpload 重入锁：避免并发调用导致同 item 被多次 uploadOne 触发。
 * - confirm 双调用防护：uploadedRefs.add 提前到 await 之前，避免并发
 *   processCompletedItems 双 confirm。
 * - allDone payload 只包含 confirm 成功的 item — 失败的仍走 error 事件。
 * - 错误反馈通道统一：组件不直接弹 ElMessage，全部走 emit('pickError'|'error')，
 *   由 caller 决定怎么展示。
 */
import { reactive, ref } from 'vue';
import { Document, DocumentRemove, UploadFilled } from '@element-plus/icons-vue';
import type { UploadFile, UploadFiles, UploadInstance } from 'element-plus';
import {
  buildCosUploadItems,
  useCosUploader,
  type CosUploadedItem,
  type CosUploaderItem,
  type CosUploadSession,
} from '@/composables/useCosUploader';
import { planPick } from './cosUploaderPickPlan';

interface Props {
  /** 必填：申请 STS 凭证 + tmp_key。返回 batch session */
  requestUpload: (files: File[]) => Promise<CosUploadSession>;
  /** 可选：单文件直传完成后回调 */
  confirm?: (item: CosUploadedItem) => Promise<unknown>;
  /** 可选：列表移除 / 组件销毁时清理 COS tmp 区 */
  cancel?: (tmpKey: string) => Promise<void>;
  /** 默认空字符串：不限制文件类型 */
  accept?: string;
  /** 默认 true */
  multiple?: boolean;
  /** 默认 0：不限制文件数 */
  limit?: number;
  /** 默认 undefined：不限制单文件大小 */
  maxSizeMB?: number;
  /** 默认 false */
  disabled?: boolean;
  /** 默认 true：选完即传；false 时仅靠 expose 的 startUpload() */
  autoUpload?: boolean;
  /** 默认 false；true 时先走 computeSha256，item 状态会经历 'hashing' */
  computeHash?: boolean;
  /** 默认 3 */
  concurrency?: number;
  /** 默认空字符串 */
  tip?: string;
  /** 列表为空时的占位文字，默认 '暂无待上传文件' */
  emptyText?: string;
}

const props = withDefaults(defineProps<Props>(), {
  confirm: undefined,
  cancel: undefined,
  accept: '',
  multiple: true,
  limit: 0,
  maxSizeMB: undefined,
  disabled: false,
  autoUpload: true,
  computeHash: false,
  concurrency: 3,
  tip: '',
  emptyText: '暂无待上传文件',
});

const emit = defineEmits<{
  change: [CosUploaderItem[]];
  uploaded: [CosUploadedItem];
  // Vue 3 + 本仓库约定（PR-3）：emit 名称一律 camelCase；模板监听仍可写 @all-done，
  // Vue 自动转换驼峰 ↔ 短横线，两端互通。spec 草稿里的 'all-done' 在代码层以 'allDone' 落地。
  allDone: [CosUploadedItem[]];
  error: [CosUploaderItem];
  exceed: [File[]];
  /** 2026-09-28 新增：选文件阶段失败（size/accept/requestUpload/multiple） */
  pickError: [message: string, file: File];
}>();

const items = ref<CosUploaderItem[]>([]);
const retryingRefs = reactive<Record<string, boolean>>({});
const uploadRef = ref<UploadInstance | null>(null);

/** 已触发 uploaded 事件的 item.client_ref，避免重试 / 二次 confirm 后重复触发 */
const uploadedRefs = new Set<string>();
/** 已触发 error 事件的 item.client_ref（confirm 失败或上传抛错） */
const errorEmittedRefs = new Set<string>();

/** 2026-09-28 新增：startUpload 重入锁 + pending 重跑标记 */
const isUploading = ref(false);
const startQueued = ref(false);

/** 2026-09-28 新增：onPick microtask 合批用缓冲与调度标记 */
const pickBuffer: File[] = [];
let flushScheduled = false;

/** 字节数 → 人类可读字符串（B / KB / MB / GB）。 */
function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * composable 内部凭证过期兜底回调：把当前所有 items 的 File 一次性提交给 caller
 * 的 requestUpload，让 caller 拼出整批 credentials / bucket / region + 对应数量
 * 的 tmp_keys。caller 自定 items 内字段名，composable 仅按数组下标对齐 tmp_key。
 */
async function refetchSession(): Promise<CosUploadSession> {
  const files: File[] = items.value.map((it) => it.file);
  return await props.requestUpload(files);
}

/**
 * 构造通用版 composable（单例，整个组件生命周期共用）。
 *
 * 2026-09-17 设计说明：
 * - initialSession 是 composable 的"批级凭证源"，但本组件的 session 来自每次
 *   onPick 调 requestUpload 拿到的最新结果，**不在 setup 期持有**。所以这里不
 *   传 initialSession，让 composable 首次 startUpload 时通过 refetchSession 兜底
 *   拿一次 session（与 useCosUpload 行为略有差异；本组件让 composable "第一次
 *   主动 refetch" 是符合 caller 模式的——caller 一次 requestUpload 拿到 session
 *   后 composable 复用，凭证过期时由 refetchSession 再拿一次）。
 * - props.computeHash / props.concurrency 用 IIFE 包一层读取放进函数体（参考
 *   PagedTable.vue 注释 PR-2 处理）：vue/no-setup-props-destructure 禁止顶层
 *   直接读 props；composable 这俩字段是构造期快照而非响应式依赖，IIFE 写法
 *   既过 lint 又语义正确。
 *
 * 2026-09-28 整改：组件 onPick 拿到 session 后会调 updateSession 喂给 composable，
 * 让 ensureFreshCredentials 看到 warm cache 后跳过兜底 refetchSession，
 * 根除「首次 onPick 调一次 + 首次 startUpload 兜底又调一次」的双调浪费。
 */
const uploader = useCosUploader({
  items,
  refetchSession,
  computeHash: ((): boolean => props.computeHash)(),
  concurrency: ((): number => props.concurrency)(),
});

const {
  startUpload: startUploadRaw,
  retryItem: retryItemRaw,
  updateSession,
  allDone,
  allOk,
} = uploader;

/**
 * 单文件直传完成后的统一收口：调 caller 的 confirm（若有），成功后 emit
 * 'uploaded'；confirm 抛错则把 item 标 error 并 emit 'error'。已触发过的
 * item 跳过（避免重试后重复触发）。
 *
 * 2026-09-28 整改：uploadedRefs.add 提前到 await 之前，防止并发
 * processCompletedItems 双 confirm；confirm 失败回滚 uploadedRefs + 标 error。
 */
async function processUploaded(it: CosUploaderItem): Promise<void> {
  const item: CosUploadedItem = {
    client_ref: it.client_ref,
    tmp_key: it.tmp_key,
    etag: it.etag,
    file: it.file,
    sha256: it.sha256,
  };
  if (props.confirm) {
    // 2026-09-28：uploadedRefs.add 提前到 await 之前，防止并发 processCompletedItems 双 confirm
    uploadedRefs.add(it.client_ref);
    try {
      await props.confirm(item);
    } catch (e) {
      // confirm 失败：回滚 uploadedRefs + 标记 error 让 UI 反映失败
      uploadedRefs.delete(it.client_ref);
      it.status = 'error';
      it.error = `confirm 失败：${(e as Error).message ?? String(e)}`;
      errorEmittedRefs.add(it.client_ref);
      emit('error', it);
      return;
    }
  } else {
    uploadedRefs.add(it.client_ref);
  }
  emit('uploaded', item);
}

/**
 * 整批 upload / retry 行为收口后跑一遍：
 * 1. status=done 且未触发 uploaded 的 item → processUploaded
 * 2. status=error 且未触发 error 的 item → emit 'error'
 * 3. 全部进入终态（done / error） → emit 'allDone'（payload 仅含 confirm 成功的）
 *
 * 2026-09-28 整改：allDone payload 仅含 confirm 成功的 item（status 仍为 done）；
 * 之前版本无差别 push，导致 caller 收到失败项的 payload 误以为是成功。
 */
async function processCompletedItems(): Promise<void> {
  const uploadedPayload: CosUploadedItem[] = [];
  for (const it of items.value) {
    if (it.status === 'done' && !uploadedRefs.has(it.client_ref)) {
      await processUploaded(it);
      // 2026-09-28：只有 confirm 成功后（status 仍为 done）才入 allDone payload
      if (it.status === 'done') {
        uploadedPayload.push({
          client_ref: it.client_ref,
          tmp_key: it.tmp_key,
          etag: it.etag,
          file: it.file,
          sha256: it.sha256,
        });
      }
    } else if (it.status === 'error' && !errorEmittedRefs.has(it.client_ref)) {
      errorEmittedRefs.add(it.client_ref);
      emit('error', it);
    }
  }
  if (
    items.value.length > 0 &&
    items.value.every((it) => it.status === 'done' || it.status === 'error')
  ) {
    emit('allDone', uploadedPayload);
  }
}

/**
 * expose 的 startUpload：包一层处理 confirm / 事件 + 重入锁。
 *
 * 2026-09-28 整改：并发 startUpload 仅标记 queued，当前批跑完后再补一轮。
 * 同一轮 batch 内多次 pick 的多次 startUpload 合并执行（do-while 循环）。
 */
async function startUpload(): Promise<void> {
  // 2026-09-28：重入保护 — 并发 startUpload 仅标记 queued，当前批跑完后再补一轮
  if (isUploading.value) {
    startQueued.value = true;
    return;
  }
  isUploading.value = true;
  try {
    // 循环直到没有 queued（同一轮 batch 内多次 pick 的多次 startUpload 合并执行）
    do {
      startQueued.value = false;
      await startUploadRaw();
      await processCompletedItems();
    } while (startQueued.value);
  } finally {
    isUploading.value = false;
  }
}

/** expose 的 retryItem：包一层处理 confirm + 触发 retrying 按钮 loading */
async function retryItem(clientRef: string): Promise<void> {
  retryingRefs[clientRef] = true;
  try {
    await retryItemRaw(clientRef);
    await processCompletedItems();
  } finally {
    retryingRefs[clientRef] = false;
    emit('change', items.value);
  }
}

/**
 * expose 的 removeItem：若 item.status=done 且 caller 注入了 cancel，先调
 * cancel 再移出；cancel 抛错仅警告不阻塞移除。
 *
 * 2026-09-28 整改：cancel 失败的 ElMessage.warning 改为 console.warn — 组件
 * 不再直接弹 ElMessage，全部走 emit('pickError'|'error') 通道统一。
 */
async function removeItem(clientRef: string): Promise<void> {
  const idx = items.value.findIndex((it) => it.client_ref === clientRef);
  if (idx === -1) return;
  const it = items.value[idx]!;
  if (it.status === 'done' && props.cancel) {
    try {
      await props.cancel(it.tmp_key);
    } catch (e) {
      // best-effort 清理失败 — 展示组件不直接弹 ElMessage
      console.warn(`[CosUploader] cancel tmp 失败：${(e as Error).message ?? String(e)}`);
    }
  }
  uploadedRefs.delete(clientRef);
  errorEmittedRefs.delete(clientRef);
  items.value.splice(idx, 1);
  emit('change', items.value);
}

/** expose 的 clear：清空整个列表，已 done 的项会触发 cancel（best-effort） */
async function clear(): Promise<void> {
  for (const it of items.value) {
    if (it.status === 'done' && props.cancel) {
      try {
        await props.cancel(it.tmp_key);
      } catch {
        // best-effort：忽略单个清理失败，整体继续
      }
    }
  }
  items.value = [];
  uploadedRefs.clear();
  errorEmittedRefs.clear();
  emit('change', items.value);
}

/**
 * 2026-09-28 整改版 onPick：
 * - 立即调 uploadRef.clearFiles() 清空 el-upload 内部幽灵列表（limit 永久超限修复）；
 * - 不立即处理，先把 raw push 到 pickBuffer；microtask 内 flushPickBuffer 合并同 tick 多次 pick
 *   （el-upload 的 on-change 在多文件拖拽 / input 多选时同步触发 N 次）。
 * - 不再调 ElMessage，所有失败走 emit('pickError', message, file)。
 */
async function onPick(uploadFile: UploadFile, _uploadFiles: UploadFiles): Promise<void> {
  const raw = uploadFile.raw as File | undefined;
  if (!raw) return;
  // P0-1 修复：每条路径（不论后续是否成功）立即清空 el-upload 内部幽灵列表。
  // clearFiles 仅 filter 内部数组、不回调 onChange（EP 2.x use-handlers.mjs:17-23），
  // 不会触发本函数重入。不用 handleRemove 是因为它会顺带调 onRemove / abort /
  // revokeFileObjectURL 等无关副作用；clearFiles 仅 filter 内部数组，最干净。
  void uploadRef.value?.clearFiles();
  pickBuffer.push(raw);
  if (flushScheduled) return;
  flushScheduled = true;
  // microtask：收集同一事件循环 tick 内所有 pick 后再 flush，
  // 让 el-upload N 次同步 on-change 合并成一次 requestUpload（性能优化 + 对齐 useUploadSession 批量语义）
  void Promise.resolve().then(async () => {
    flushScheduled = false;
    await flushPickBuffer();
  });
}

/**
 * microtask flush：合并 pickBuffer 内所有文件，做 size/accept/limit/multiple/requestUpload 全校验，
 * 一次性拿 session + build items + updateSession + startUpload（带重入锁）。
 */
async function flushPickBuffer(): Promise<void> {
  if (pickBuffer.length === 0) return;
  const buffer = pickBuffer.splice(0, pickBuffer.length);

  const plan = planPick(
    buffer,
    {
      maxSizeMB: props.maxSizeMB,
      accept: props.accept,
      limit: props.limit,
      multiple: props.multiple,
    },
    items.value.length,
  );

  // emit 各类型拒绝事件
  if (plan.rejectedByLimit.length > 0) {
    emit('exceed', plan.rejectedByLimit);
  }
  for (const r of plan.rejectedBySize) emit('pickError', r.reason, r.file);
  for (const r of plan.rejectedByAccept) emit('pickError', r.reason, r.file);
  for (const r of plan.rejectedByMultiple) emit('pickError', r.reason, r.file);

  if (plan.accepted.length === 0) return;

  let session: CosUploadSession;
  try {
    session = await props.requestUpload(plan.accepted);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    for (const f of plan.accepted) {
      emit('pickError', `申请上传凭证失败：${msg}`, f);
    }
    return;
  }

  const built = buildCosUploadItems(plan.accepted, session, {
    computeHash: props.computeHash,
  });
  items.value.push(...built);
  emit('change', items.value);
  // 2026-09-28：拿到 session 后立即喂 composable，让 ensureFreshCredentials 看到
  // warm cache 后跳过兜底 refetch，根除「首次 onPick 调一次 + 首次 startUpload
  // 兜底又调一次」的双调浪费。
  updateSession(session);

  if (props.autoUpload) {
    await startUpload();
  }
}

// matchesAccept 仅组件本地使用时被 pickPlan 替代；此处不再保留本地实现，
// 完整解析逻辑走 src/components/cosUploaderPickPlan.ts。
// 2026-09-28：旧版 beforeUpload 恒返回 false（避免 el-upload 自带 action
// 触发）。2026-09-28 整改后本组件 :auto-upload="false" + 自实现完整上传流程，
// 已不需要 beforeUpload 钩子，删除避免误导。
// 旧版 onExceed：超出 limit 时 ElMessage.warning + emit 'exceed'。
// 2026-09-28 整改后 limit 走 planPick 自实现，el-upload 不再传 :limit，
// onExceed 不再被触发。

defineExpose({
  items,
  startUpload,
  retryItem,
  removeItem,
  clear,
  allDone,
  allOk,
});
</script>

<style lang="scss" scoped>
.cos-uploader {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.cos-uploader__tip {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.cos-uploader__size-hint,
.cos-uploader__accept-hint {
  margin-left: 8px;
}
.cos-uploader__list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  overflow: hidden;
}
.cos-uploader__row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  min-height: 60px;
  border-bottom: 1px solid var(--el-border-color-lighter);

  &:last-child {
    border-bottom: none;
  }
}
.cos-uploader__icon {
  color: var(--el-color-primary);
  font-size: 20px;
}
.cos-uploader__meta {
  min-width: 0;
}
.cos-uploader__name {
  font-size: 14px;
  font-weight: 500;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cos-uploader__sub {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.cos-uploader__progress {
  margin-top: 4px;
}
.cos-uploader__error-msg {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-color-danger);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cos-uploader__actions {
  display: flex;
  gap: 4px;
}
.cos-uploader__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 16px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>
