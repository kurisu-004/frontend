// composables/usePartFileUpload.ts —— 零件详情页补传（场景 1，2026-10-15 改直传）
//
// 零件已存在 → 仅补传文件。DRAWING / 3D_MODEL / CAD_2D 三个 kind 共用此 composable
// （kind 只决定 t_part_file.kind 槽位，不影响上传流程）。
//
// 流程四步（传输实现在 `utils/directUpload.ts`，本文件只做参数归一 + 状态暴露）：
//   1. computeSha256(file)            64-char 小写 hex（秒传判据 + 登记依据）
//   2. POST /files/upload-intents     拿 object_key + 预签 PUT URL（可能秒传短路）
//   3. XHR PUT 直传对象存储            带真进度、不经后端进程
//   4. POST /files/objects/confirm    登记，返回 PartFileItem
//
// 为什么独立 composable：Tab2 的 PDF 批量是「建单成功后逐 job 补传」（多目标、并发、
// 状态格），这里的场景是「详情页已有零件，换个文件补一下」（单目标、串行、失败即抛）。
// 两者只有前四步相同（那是共享引擎的职责），编排形状完全不同。
//
// 雪花 ID 全程 string（ownerPartId = string；PartFileItem.id = string）。
import { ref, type Ref } from 'vue';
import { directUpload } from '@/utils/directUpload';
import type { PartFileItem } from '@/types/file_intent';

/** 补传允许的 kind 子集（G_CODE / SETUP_SHEET 由 CNC 配对那套管，ASSEMBLY_MASTER / DELIVERY_TEMPLATE 各自另有场景）。 */
export type PartFileUploadKind = 'DRAWING' | '3D_MODEL' | 'CAD_2D';

export interface UsePartFileUploadOptions {
  /** 雪花 ID string；owner_id 锁到当前 part。
   *  支持 Ref<string> / getter / 直接字面量三种形态。 */
  ownerPartId: Ref<string> | (() => string) | string;
  /** 文件分类，决定 t_part_file.kind 槽位。
   *  支持 Ref / getter / 直接字面量三种形态。 */
  kind: Ref<PartFileUploadKind> | (() => PartFileUploadKind) | PartFileUploadKind;
}

export interface UsePartFileUploadReturn {
  /** 单文件上传入口。返回后端登记后的 PartFileItem；UI 拿到后调 refresh 列表。 */
  upload: (file: File) => Promise<PartFileItem>;
  /** 当前是否在上传中（用于按钮 loading / disable）。 */
  uploading: Ref<boolean>;
  /** 最近一次错误（便于 UI 显示）。 */
  lastError: Ref<string | null>;
}

/**
 * 详情页补传 composable（单文件）。
 *
 * - upload() 接受任意 File；hash → intents → PUT → confirm 全在一段内串行，方便在
 *   FileListCard 的 `props.apiUpload(ownerId, file)` 里直接 await；
 * - owner 与 kind 都在闭包里由 `usePartFilesPanel` 按三个 tab 分别实例化，调用方
 *   签名（`(ownerId, file)`）由那一层的适配器补齐。
 */
export function usePartFileUpload(opts: UsePartFileUploadOptions): UsePartFileUploadReturn {
  // ownerPartId / kind 的入参支持三种形态，统一归一化成「调用时取值」的 thunk，
  // 让 upload() 体内只有一套取值逻辑。
  const resolveOwnerId = (): string => {
    const v = opts.ownerPartId;
    if (typeof v === 'function') return (v as () => string)();
    if (typeof v === 'object' && v !== null && 'value' in v) return (v as Ref<string>).value;
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
    const curOwnerId = resolveOwnerId();
    if (!curOwnerId) {
      const msg = 'usePartFileUpload: ownerPartId 为空，无法补传';
      lastError.value = msg;
      throw new Error(msg);
    }
    uploading.value = true;
    try {
      const { item } = await directUpload({
        ownerKind: 'PART',
        ownerId: curOwnerId,
        kind: resolveKind(),
        file,
      });
      return item;
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
