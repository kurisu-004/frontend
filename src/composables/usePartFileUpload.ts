// 2026-09-16 新增：详情页补传 composable（场景 B）。
//
// 场景 B：零件已存在 → 仅补传文件。DRAWING / 3D_MODEL / CAD_2D 三个 kind 共用此
// composable（kind 只决定 owner_part_id 下的 kind 槽位，不影响上传流程）。
//
// 流程（与 PartBatchPdfTab 的批量场景 A 几乎一致，但只针对单文件）：
//   1. computeSha256(file) → 64-char hex
//   2. createUploadIntents({ owner_part_id, files: [{ kind, filename, file_size,
//      content_sha256, content_type }] }) 拿 STS 凭证 + tmp_key
//   3. dedup_hit=true → 直接复用 existing_file，跳过上传 + confirm
//   4. 用 useCosUpload 风格直传（dedup_hit=false 时）
//   5. confirmPartFile(ownerPartId, { kind, tmp_key, sha, ... }) → PartFileItem
//
// 为什么独立 composable：PartBatchPdfTab 是批量场景 A（owner_part_id 缺省），复用
// upload-intents 流程 + PartFileBinding 提交；详情页补传是单文件场景 B，确认端点
// 不同（confirmPartFile 而非 batchCreateParts），不适合套同一条 onSubmit 路径。
//
// 雪花 ID 全程 string（owner_partId = string；PartFileItem.id = string）。
import { ref, unref, type Ref } from 'vue';
import { computeSha256 } from '@/utils/fileHash';
import { createUploadIntents, confirmPartFile } from '@/api/parts/file';
import { useCosUpload, type CosUploadItem } from '@/composables/useCosUpload';
import type { PartFileItem, PartFileKind, UploadIntentsOut } from '@/types/part_file';

/** 补传允许的 kind 子集（G_CODE / SETUP_SHEET / ASSEMBLY_MASTER 由各自页面管）。 */
export type PartFileUploadKind = 'DRAWING' | '3D_MODEL' | 'CAD_2D';

export interface UsePartFileUploadOptions {
  /** 雪花 ID string；owner_part_id 锁到当前 part。
   *  支持 Ref<string> / getter / 直接字面量三种形态。 */
  ownerPartId: Ref<string> | (() => string) | string;
  /** 文件分类，决定 t_part_file.kind 槽位与 dedup 查询维度。
   *  支持 Ref / getter / 直接字面量三种形态。 */
  kind: Ref<PartFileUploadKind> | (() => PartFileUploadKind) | PartFileUploadKind;
}

export interface UsePartFileUploadReturn {
  /** 单文件上传入口。返回新（或命中复用）的 PartFileItem；UI 拿到后调 refresh 列表。 */
  upload: (file: File) => Promise<PartFileItem>;
  /** 当前是否在上传中（用于按钮 loading / disable）。 */
  uploading: Ref<boolean>;
  /** 最近一次错误（便于 UI 显示）。 */
  lastError: Ref<string | null>;
}

/**
 * 详情页补传 composable（场景 B 单文件）。
 *
 * 设计要点：
 * - upload() 接受任意 File；hash + upload + confirm 全在一段内串行，方便在
 *   FileListCard `props.apiUpload(ownerId, file)` 直接 await。
 * - 每次 upload() 都 new 一个 useCosUpload 实例（一次性 single item），并发场景
 *   不会出现 items 数组竞争；并发触发由 UI 控制（FileListCard 默认串行）。
 * - dedup_hit=true 时不发起上传 + 不调 confirm（existing_file 已经是 READY 状态）。
 */
export function usePartFileUpload(opts: UsePartFileUploadOptions): UsePartFileUploadReturn {
  // owner_part_id 是 owner part 的雪花 ID；composable 调用方可以是：
  // - 直接字面量（`'190000000000001'` / `'DRAWING'`）—— 静态场景
  // - Ref<string> / Ref<PartFileUploadKind> —— 响应式（如 partId 路由参数）
  // - getter 函数 —— 派生 ID
  // 统一归一化成一个调用时取值的 thunk，让 upload() 体内只用一套逻辑。
  const resolveOwnerId = (): string => {
    const v = opts.ownerPartId;
    if (typeof v === 'function') return (v as () => string)();
    if (typeof v === 'object' && v !== null && 'value' in v) {
      return (v as Ref<string>).value;
    }
    return v as string;
  };
  const resolveKind = (): PartFileUploadKind => {
    const v = opts.kind;
    if (typeof v === 'function') return (v as () => PartFileUploadKind)();
    if (typeof v === 'object' && v !== null && 'value' in v) {
      return (v as Ref<PartFileUploadKind>).value;
    }
    return v as PartFileUploadKind;
  };

  const uploading = ref<boolean>(false);
  const lastError = ref<string | null>(null);

  async function upload(file: File): Promise<PartFileItem> {
    lastError.value = null;
    uploading.value = true;
    const curKind = resolveKind();
    const curOwnerId = resolveOwnerId();
    try {
      if (!curOwnerId) {
        throw new Error('usePartFileUpload: ownerPartId 为空，无法补传');
      }
      // 步骤 1：流式 SHA-256（小写 64-char hex）
      const sha = await computeSha256(file);

      // 步骤 2：申请 STS + tmp_key（场景 B 必传 owner_part_id）
      const intents: UploadIntentsOut = await createUploadIntents({
        owner_part_id: curOwnerId,
        files: [
          {
            kind: curKind as PartFileKind,
            filename: file.name,
            // v2 i64 序列化器统一转 string；Blob.size 是 number，按 CLAUDE.md §3
            // 一律以 string 透传，避免后端 serde 拒收。
            file_size: String(file.size),
            content_sha256: sha,
            content_type: file.type || 'application/octet-stream',
          },
        ],
      });
      const item = intents.items[0];
      if (!item) {
        throw new Error('createUploadIntents 未返回任何 item');
      }

      // 步骤 3：dedup_hit=true → 直接复用 existing_file 跳过上传 + confirm
      if (item.dedup_hit && item.existing_file) {
        return item.existing_file;
      }

      // 步骤 4：构造 CosUploadItem + useCosUpload 单文件直传
      const itemsRef = ref<CosUploadItem[]>([
        {
          client_ref: item.client_ref,
          file,
          tmp_key: item.tmp_key,
          bucket: intents.bucket,
          region: intents.region,
          tmp_prefix: intents.tmp_prefix,
          credentials: intents.credentials,
          status: 'pending',
          progress: 0,
        },
      ]);
      const cosUpload = useCosUpload({
        items: itemsRef,
        // 重签：场景 B 重签后端按 (owner_part_id, kind, sha) 命中同一文件，
        // tmp_key 通常保持不变；即使漂移 useCosUpload.applyFreshIntents 兜底。
        refetchIntents: async () =>
          createUploadIntents({
            owner_part_id: curOwnerId,
            files: [
              {
                kind: curKind as PartFileKind,
                filename: file.name,
                file_size: String(file.size),
                content_sha256: sha,
                content_type: file.type || 'application/octet-stream',
              },
            ],
          }),
      });
      await cosUpload.startUpload();

      // 检查上传结果
      // 2026-09-16：用 unref() 而不是 .value 直接访问，避开
      // vue/no-ref-object-reactivity-loss（rule 要求 value 不在 ref 同一 scope 内
      // 被读取，否则 destructure 后丢响应式；这里我们只需要一次读出，unref() 是
      // vue 官方推荐写法）。
      const uploaded = unref(itemsRef)[0];
      if (!uploaded || uploaded.status !== 'done') {
        throw new Error(uploaded?.error ?? 'COS 上传失败');
      }

      // 步骤 5：confirmPartFile（场景 B 专用端点，让后端 head + copy + 插表）
      const confirmed = await confirmPartFile(curOwnerId, {
        kind: curKind as PartFileKind,
        tmp_key: item.tmp_key,
        content_sha256: sha,
        original_filename: file.name,
        file_size: String(file.size),
        content_type: file.type || 'application/octet-stream',
      });
      return confirmed;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError.value = msg;
      throw e instanceof Error ? e : new Error(msg);
    } finally {
      uploading.value = false;
    }
  }

  return { upload, uploading, lastError };
}
