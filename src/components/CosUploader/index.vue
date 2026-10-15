<!--
  index.vue —— CosUploader 主组件（对外唯一入口）

  封装「选文件 → 算 hash（调用方在签发时做）→ 申请预签 URL → XHR 直传对象存储 →
  caller confirm」全流程。配套：
  - 类型契约 src/components/CosUploader/types.ts
  - 底层状态机 src/components/CosUploader/useCosUploader.ts
  - 选文件纯函数 src/components/CosUploader/pickPlan.ts
  - 子组件 UploadArea.vue（拖拽 / 点击区）+ FileList.vue（文件列表展示壳）

  2026-10-15：上传传输由「STS 临时凭证 + cos-js-sdk-v5」改为「预签 PUT URL + XHR
  直传」（`utils/presignedPut.ts`）。UI 结构与交互不变。
  ⚠️ **同批改造后本组件的生产调用方归零**：`views/parts/new/components/PartEntryFormDialog.vue`
  原先是唯一的消费方，而零件 Tab1 已改成「先建单、再传文件」的时序 ⇒ 对话框里的图纸位
  只**暂存** File（`<el-upload :auto-upload="false">`），不再需要「选完即传」的组件。
  组件与其状态机保留 —— 它是仓内唯一的「多文件批量 + 逐项进度 / 重试 / 移除」通用上传
  壳，下一个有同类需求的域可以直接注入一个 `getUploadIntents` 复用。若最终确认长期没有
  消费方，整包（`index.vue` / `useCosUploader.ts` / `UploadArea.vue` / `FileList.vue` /
  `pickPlan.ts` / `types.ts` + 两份 spec）可以整体删除，删前请先确认无 import。

  与 FileListCard.vue 的差异：
  - FileListCard 强绑 part-file 域（PartFileItem / PartFileKind）；
  - 本组件零业务字段：kind / owner / SHA-256 全在调用方实现 `getUploadIntents` 的
    闭包里，组件自身不 import 任何 api/files、api/parts 域特定模块。

  拆分历史（2026-09-28）：原单文件 609 行拆成
  UploadArea / FileList / index.vue 三 SFC + composable + types + pickPlan。
  index.vue 持状态机 + planPick 校验 + microtask 合批 + 重入锁 + confirm 双调用
  防护 + 事件派发；uploadAreaRef 通过 defineExpose.clearInternal() 清空 el-upload
  内部幽灵列表。
-->

<template>
  <div class="cos-uploader">
    <UploadArea
      ref="uploadAreaRef"
      :accept="accept"
      :multiple="multiple"
      :disabled="disabled"
      :tip="tip"
      :max-size-m-b="maxSizeMB"
      @pick="onPick"
    />
    <FileList
      :items="items"
      :retrying-refs="retryingRefs"
      :empty-text="emptyText"
      @retry="retryItem"
      @remove="removeItem"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 通用直传上传 UI 组件。
 *
 * 内部消费 useCosUploader（src/components/CosUploader/useCosUploader.ts）实现上传
 * 状态机；caller 通过 Props 注入业务端点（getUploadIntents / confirm / cancel），
 * 组件自身零业务字段。
 *
 * Props / Events / Exposes 见对应 defineProps / defineEmits / defineExpose。
 *
 * 组件层的三条不变量（改这块时逐条对照）：
 * - 删 el-upload 的 :limit / :before-upload / :on-exceed —— el-upload 内部列表会泄漏
 *   （每选一次 push 一条），`:limit` 会永久超限。改在组件内自实现 limit（planPick）；
 *   每次 onPick 立即 clearInternal() 清空内部幽灵列表。
 * - onPick 走 microtask 合批：el-upload 的 on-change 在多文件拖拽 / input 多选时同步
 *   触发 N 次，buffer 后 microtask flush 让 N 次合并成**一次** getUploadIntents
 *   （一次 HTTP 拿一批 URL，而不是 N 次）。
 * - startUpload 重入锁：避免并发调用导致同 item 被多次触发。
 *
 * 错误反馈通道统一：组件不直接弹 ElMessage，全部走 emit('pickError' | 'error')，
 * 由 caller 决定怎么展示。
 */
import { reactive, ref } from 'vue';
import type { UploadFile, UploadFiles } from 'element-plus';
import { buildCosUploaderItems, useCosUploader } from './useCosUploader';
import type { PartFileItem } from '@/types/file_intent';
import type { CosUploaderItem, CosUploadedItem, GetUploadIntents } from './types';
import { planPick } from './pickPlan';
import UploadArea from './UploadArea.vue';
import FileList from './FileList.vue';

interface Props {
  /**
   * 必填：为一批 File 签发上传意图。实现方负责算 SHA-256、拼 kind / owner /
   * content_type 并调 `api/files/intents.ts::grantUploadIntents`，把响应 items[] 原样
   * 返回；组件按下标对齐。
   */
  getUploadIntents: GetUploadIntents;
  /** 可选：单文件上传完成后回调（业务侧在此调 confirm 端点登记，返回 PartFileItem 即可）。 */
  confirm?: (item: CosUploadedItem) => Promise<unknown>;
  /** 可选：列表移除 / 组件销毁时的清理回调（入参是已上传的对象 key）。 */
  cancel?: (objectKey: string) => Promise<void>;
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
  /** 默认 false；true 时先显示 'hashing' 态并让 hash 阶段占进度 0-30%。 */
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
  allDone: [CosUploadedItem[]];
  error: [CosUploaderItem];
  exceed: [File[]];
  /** 选文件阶段失败（size / accept / getUploadIntents / multiple）。 */
  pickError: [message: string, file: File];
}>();

const items = ref<CosUploaderItem[]>([]);
const retryingRefs = reactive<Record<string, boolean>>({});
const uploadAreaRef = ref<InstanceType<typeof UploadArea> | null>(null);

/** 已触发 uploaded 事件的 item.client_ref，避免重试 / 二次 confirm 后重复触发。 */
const uploadedRefs = new Set<string>();
/** 已触发 error 事件的 item.client_ref（上传失败或 confirm 失败）。 */
const errorEmittedRefs = new Set<string>();

/** startUpload 重入锁 + pending 重跑标记。 */
const isUploading = ref(false);
const startQueued = ref(false);

/** onPick microtask 合批用的缓冲与调度标记。 */
const pickBuffer: File[] = [];
let flushScheduled = false;

/**
 * 构造通用版状态机（单例，整个组件生命周期共用）。
 *
 * props.computeHash / props.concurrency 用 IIFE 包一层读取放进函数体（参考
 * PagedTable.vue 的处理）：vue/no-setup-props-destructure 规则要求 `props.xxx` 在
 * root scope 之外读取才不丢响应性；这两个字段是构造期快照而非响应式依赖。
 */
const uploader = useCosUploader({
  items,
  // IIFE 包一层：`vue/no-setup-props-destructure` 规则要求 props 不在 root scope 直读。
  // getUploadIntents 是构造期注入的回调（不是响应式依赖），读一次即固定。
  getUploadIntents: ((): GetUploadIntents => props.getUploadIntents)(),
  computeHash: ((): boolean => props.computeHash)(),
  concurrency: ((): number => props.concurrency)(),
});

const { startUpload: startUploadRaw, retryItem: retryItemRaw, allDone, allOk } = uploader;

/**
 * 单文件直传完成后的统一收口：调 caller 的 confirm（若有），成功后 emit 'uploaded'；
 * confirm 抛错则把 item 标 error 并 emit 'error'。已触发过的 item 跳过。
 *
 * 秒传命中的项**不调 confirm**（后端已经把文件登记好了，再调一次就是重复登记），
 * 直接以 `existing_file` 落 done 并 emit 'uploaded'。
 */
async function processUploaded(it: CosUploaderItem): Promise<void> {
  const item: CosUploadedItem = {
    client_ref: it.client_ref,
    object_key: it.object_key,
    existing_file: it.existing_file,
    file: it.file,
    sha256: it.sha256 ?? '',
    already_exists: it.already_exists,
  };
  if (props.confirm && !it.already_exists) {
    // uploadedRefs.add 提前到 await 之前，防止并发 processUploadedItems 双 confirm。
    uploadedRefs.add(it.client_ref);
    try {
      const done = await props.confirm(item);
      // confirm 返回 PartFileItem 时透出给调用方（拿得到文件行 id，省一次 refetch）。
      if (done && typeof done === 'object' && 'id' in done) {
        item.file_item = done as PartFileItem;
      }
    } catch (e) {
      // confirm 失败：回滚 uploadedRefs + 标记 error 让 UI 反映失败。
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
 * 整批 upload / retry 跑完后统一收口：
 * 1. status=done 且未触发 uploaded 的项 → processUploaded；
 * 2. status=error 且未触发 error 的项 → emit 'error'；
 * 3. 全部进入终态 → emit 'allDone'（payload 仅含确认成功的）。
 */
async function processCompletedItems(): Promise<void> {
  const uploadedPayload: CosUploadedItem[] = [];
  for (const it of items.value) {
    if (it.status === 'done' && !uploadedRefs.has(it.client_ref)) {
      await processUploaded(it);
      // 只有收口后 status 仍是 done（confirm 没失败）才进 allDone payload。
      if (it.status === 'done') {
        uploadedPayload.push({
          client_ref: it.client_ref,
          object_key: it.object_key,
          existing_file: it.existing_file,
          file: it.file,
          sha256: it.sha256 ?? '',
          already_exists: it.already_exists,
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

/** expose 的 startUpload：包一层重入锁 + confirm / 事件派发。 */
async function startUpload(): Promise<void> {
  // 并发 startUpload 仅标记 queued，当前批跑完后再补一轮。
  if (isUploading.value) {
    startQueued.value = true;
    return;
  }
  isUploading.value = true;
  try {
    do {
      startQueued.value = false;
      await startUploadRaw();
      await processCompletedItems();
    } while (startQueued.value);
  } finally {
    isUploading.value = false;
  }
}

/** expose 的 retryItem：包一层 confirm 派发 + 重试按钮 loading。 */
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

/** expose 的 removeItem：已 done 且注入了 cancel 时先 best-effort 清理对象。 */
async function removeItem(clientRef: string): Promise<void> {
  const idx = items.value.findIndex((it) => it.client_ref === clientRef);
  if (idx === -1) return;
  const it = items.value[idx]!;
  if (it.status === 'done' && props.cancel && it.object_key) {
    try {
      await props.cancel(it.object_key);
    } catch (e) {
      // best-effort 清理失败 —— 展示组件不直接弹 ElMessage。
      console.warn(`[CosUploader] cancel 对象清理失败：${(e as Error).message ?? String(e)}`);
    }
  }
  uploadedRefs.delete(clientRef);
  errorEmittedRefs.delete(clientRef);
  items.value.splice(idx, 1);
  emit('change', items.value);
}

/** expose 的 clear：清空整个列表，已 done 的项会 best-effort 清理对象。 */
async function clear(): Promise<void> {
  for (const it of items.value) {
    if (it.status === 'done' && props.cancel && it.object_key) {
      try {
        await props.cancel(it.object_key);
      } catch {
        // best-effort：忽略单个清理失败，整体继续。
      }
    }
  }
  items.value = [];
  uploadedRefs.clear();
  errorEmittedRefs.clear();
  emit('change', items.value);
}

/**
 * onPick：立即 clearInternal() 清 el-upload 内部幽灵列表，再把 raw 推入缓冲，
 * microtask 内 flush 合并同一 tick 的多次 pick。
 */
async function onPick(uploadFile: UploadFile, _uploadFiles: UploadFiles): Promise<void> {
  const raw = uploadFile.raw as File | undefined;
  if (!raw) return;
  uploadAreaRef.value?.clearInternal();
  pickBuffer.push(raw);
  if (flushScheduled) return;
  flushScheduled = true;
  void Promise.resolve().then(async () => {
    flushScheduled = false;
    await flushPickBuffer();
  });
}

/**
 * microtask flush：合并缓冲内所有文件，做 size / accept / limit / multiple 校验，
 * 一次性签发 intents + build items + startUpload（带重入锁）。
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

  if (plan.rejectedByLimit.length > 0) emit('exceed', plan.rejectedByLimit);
  for (const r of plan.rejectedBySize) emit('pickError', r.reason, r.file);
  for (const r of plan.rejectedByAccept) emit('pickError', r.reason, r.file);
  for (const r of plan.rejectedByMultiple) emit('pickError', r.reason, r.file);

  if (plan.accepted.length === 0) return;

  let intents;
  try {
    intents = await props.getUploadIntents(plan.accepted);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    for (const f of plan.accepted) emit('pickError', `申请上传地址失败：${msg}`, f);
    return;
  }

  if (intents.length !== plan.accepted.length) {
    // 响应项数与文件数不等 ⇒ 无法按下标对齐，硬失败好过把 A 的 URL 拿去传 B。
    const msg = `申请上传地址失败：返回项数（${intents.length}）≠ 文件数（${plan.accepted.length}）`;
    for (const f of plan.accepted) emit('pickError', msg, f);
    return;
  }

  items.value.push(...buildCosUploaderItems(plan.accepted, intents));
  emit('change', items.value);

  if (props.autoUpload) await startUpload();
}

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
</style>
