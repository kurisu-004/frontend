// 2026-09-16 新增：详情页补传 composable（场景 B）。
//
// 场景 B：零件已存在 → 仅补传文件。DRAWING / 3D_MODEL / CAD_2D 三个 kind 共用此
// composable（kind 只决定 owner_part_id 下的 kind 槽位，不影响上传流程）。
//
// 流程（与 PartBatchPdfTab 的批量场景 A 几乎一致，但只针对单文件）：
//   1. computeSha256(file) → 64-char hex
//   2. grantStsTmpKey({ purpose, filename, content_sha256 }) 拿 STS 凭证 + tmp_key
//      （python 端 POST /api/v1/files/sts-tmp-keys，2026-09-17 起替换原
//       backend-rust POST /api/v2/part-files/upload-intents）
//   3. 拼装 UploadIntentsOut（part-file 专用形状）喂给 useCosUpload 直传
//   4. confirmPartFile(ownerPartId, { kind, tmp_key, sha, ... }) → PartFileItem
//
// 为什么独立 composable：PartBatchPdfTab 是批量场景 A，确认端点不同
//（batchCreateParts 而非 confirmPartFile），不适合套同一条 onSubmit 路径。
//
// 雪花 ID 全程 string（owner_partId = string；PartFileItem.id = string）。
//
// 2026-09-17 STS 端口迁移说明：
// - 原 createUploadIntents（backend-rust bulk 1+key + dedup_hit）已下线；本场景
//   走 python 单端口 1-key grantStsTmpKey，每次上传独立签发。
// - dedup 语义在 python STS 端**不实现**（无 dedup_hit / existing_file 字段）；
//   按 2026-09-17 用户决策"不要 dedup"，本 composable 移除该分支：每次补传
//   都新传 → confirm，与历史行为基本一致（仅去掉复用旧文件短路）。
// - useCosUpload 仍接 UploadIntentsOut 形态（part-file 域专用 composable），
//   我们把 grantStsTmpKey 单 key 响应塞进 1 项数组，包成 UploadIntentsOut
//   后再喂入。refetchIntents 同源调用，凭证过期时重签。
import { ref, unref, type Ref } from 'vue';
import { computeSha256 } from '@/utils/fileHash';
import { confirmPartFile } from '@/api/parts/file';
import { grantStsTmpKey } from '@/api/files/sts';
import { useCosUpload, type CosUploadItem } from '@/composables/useCosUpload';
import { PartFileKindToStsPurpose, type StsTmpKeysResponse } from '@/types/sts';
import type {
  PartFileItem,
  PartFileKind,
  UploadIntentsOut,
  UploadIntentItemOut,
} from '@/types/part_file';

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
  /** 单文件上传入口。返回新 PartFileItem；UI 拿到后调 refresh 列表。
   *  2026-09-17：python STS 端口无 dedup 语义，每次补传都新传 → confirm，
   *  不再返回"命中复用的 existing_file"路径。 */
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
 * - 2026-09-17 STS 端口迁移后不再走 dedup_hit 短路：每次补传都新传 → confirm，
 *   旧文件复用路径（existing_file）已下线（python STS 无该语义）。
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

  /**
   * 把 python STS 单端口响应包装成 useCosUpload 期待的 UploadIntentsOut 形态。
   *
   * useCosUpload 是 part-file 域专用 composable（part_file.ts 域类型），它按
   * client_ref 索引对齐 credentials / tmp_key；grantStsTmpKey 单端口响应里
   * client_ref 不存在（python 端不感知 client_ref），caller 自行用 crypto.randomUUID()
   * 生成。tmp_key 直接来自 sts.tmp_key；credentials 走通用 CosCredentials 子集
   *（sts.credentials 多 1 个 start_time 字段，caller 不消费）。
   *
   * upload_prefix 是 python 端 STS policy resource 限定前缀（展示用；实际
   * tmp_key 已自含），按 part-file UploadIntentsOut.tmp_prefix 同形字段塞入。
   */
  function wrapSingleIntents(
    sts: StsTmpKeysResponse,
    clientRef: string,
  ): { intents: UploadIntentsOut; item: UploadIntentItemOut } {
    const item: UploadIntentItemOut = {
      client_ref: clientRef,
      tmp_key: sts.tmp_key,
      // 2026-09-17：python STS 端口无 dedup 语义；固定 false，composable 内部
      // 永远走直传路径（与原 backend-rust dedup_hit=false 分支同形）。
      dedup_hit: false,
    };
    const intents: UploadIntentsOut = {
      // python 端多 1 个 start_time 字段，caller 不需要；按 part-file 域
      // CosCredentials 子集构造（字段集是 sup，这里直接 as 即可，TS 允许
      // 结构上多字段的对象赋给少字段的结构）。
      credentials: sts.credentials,
      bucket: sts.bucket,
      region: sts.region,
      tmp_prefix: sts.upload_prefix,
      items: [item],
    };
    return { intents, item };
  }

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

      // 步骤 2：申请 STS + tmp_key（python 端单端口 1-key）。
      // client_ref 由 caller 用 crypto.randomUUID() 生成；useCosUpload.applyFreshIntents
      // 按 client_ref 索引对齐，refetchIntents 必须复用同一 client_ref。
      const clientRef = crypto.randomUUID();

      /**
       * 调 grantStsTmpKey + 包成 UploadIntentsOut；用于首次 + 凭证过期重签。
       * 单文件场景，所以只调一次 python 端。client_ref 在外层稳定持有，refetch
       * 复用同一 client_ref 让 useCosUpload.applyFreshIntents 按 Map 找到对应 item。
       *
       * 这里必须嵌套在 upload() 闭包内，因为 refetchIntents 可能在 upload() 返回后
       * 由 useCosUpload 异步触发——闭包持有 curKind / sha / file 让 refetch 能拿到
       * 同一组参数（python 端按 (purpose, filename, content_sha256) 派生唯一 tmp_key，
       * 参数漂移会导致重签后 tmp_key 变化，进而触发 useCosUpload.applyFreshIntents
       * 的强制重传兜底）。
       */
      const fetchIntents = async (): Promise<UploadIntentsOut> => {
        const sts = await grantStsTmpKey({
          purpose: PartFileKindToStsPurpose[curKind] ?? 'tmp',
          filename: file.name,
          content_type: file.type || 'application/octet-stream',
          // python schema 约束 16-64 hex；前端算 SHA-256 截前 16 hex（与后端
          // schema/sts.py StsTmpKeysRequest.content_sha256 字段定义对齐）。
          content_sha256: sha.slice(0, 16),
        });
        return wrapSingleIntents(sts, clientRef).intents;
      };

      const intents = await fetchIntents();
      const item = intents.items[0];
      if (!item) {
        throw new Error('grantStsTmpKey 未返回 tmp_key（响应异常）');
      }

      // 步骤 3：构造 CosUploadItem + useCosUpload 单文件直传
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
        // 凭证过期重签：复用同一 client_ref；tmp_key 通常保持不变，即使漂移
        // useCosUpload.applyFreshIntents 会兜底强制 reset pending 强制重传。
        refetchIntents: fetchIntents,
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

      // 步骤 4：confirmPartFile（场景 B 专用端点，让后端 head + copy + 插表）
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
