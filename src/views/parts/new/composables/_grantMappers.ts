// _grantMappers.ts —— python STS 响应 ↔ CosUploader/UploadIntentsOut 适配层
//
// 2026-09-28 子任务 #5 新增：复用映射逻辑，避免 usePartBatchManual 与 usePartBatchPdf
// 双 caller 各自重复字段挑选。usePartFileUpload（链路 A）仍保留原 inline 包装
// （wrapSingleIntents），不强行抽到这里 —— 单文件场景无需共享映射。
//
// 设计要点：
// - 仅做"字段挑选 + 类型适配"，不发起任何 HTTP / 不引入副作用；
// - python 端 STS 响应字段集（`StsTmpKeysResponse`：含 start_time / endpoint /
//   scheme / expires_in / upload_prefix）→ CosUploader 最小骨架（CosCredentials +
//   bucket + region + tmp_key）的子集挑选；
// - CosUploader 的 client_ref 由 caller 用 crypto.randomUUID() 生成（见各 caller
//   注释），这里只暴露一个 helper 帮你把 (sts, clientRef) 转成 item。

import type { CosCredentials, CosUploadGrant } from '@/components/CosUploader/types';
import type { StsTmpKeysResponse } from '@/types/sts';

/**
 * 把 python 端 STS 凭证（StsCredentialsOut）映射到 CosUploader 通用最小骨架
 *（CosCredentials）。
 *
 * 字段挑选：
 * - tmp_secret_id / tmp_secret_key / session_token：原样塞入；
 * - expired_time：i64 秒数（python 端 JSON 解析为 number），CosUploader 用 ms 比较
 *   时由调用方 `* 1000`（详见 `isCredentialExpiring`）。
 *
 * 未消费的字段：start_time（仅审计）。CosUploader 不感知，永不传送。
 */
export function stsCredentialsToCosCredentials(sts: StsTmpKeysResponse): CosCredentials {
  return {
    tmp_secret_id: sts.credentials.tmp_secret_id,
    tmp_secret_key: sts.credentials.tmp_secret_key,
    session_token: sts.credentials.session_token,
    expired_time: sts.credentials.expired_time,
  };
}

/**
 * 把单次 StsTmpKeysResponse（python 单端口 1-key 响应）装配成
 * `useCosUploader` / `useCosUpload` 期望的 `CosUploadGrant`（共享批级
 * credentials / bucket / region + items[i].tmp_key）。
 *
 * client_ref 由 caller 提供（每文件独立生成，stableAcrossRefetch：refetchIntents
 * 重签时**必须复用同一 client_ref**，否则 useCosUpload.applyFreshIntents 按
 * client_ref 索引找不到对应 item，会留旧凭证。详见 usePartFileUpload + 新双 caller
 * 实现）。
 *
 * @example
 * ```ts
 * const head = grants.items[0]!;
 * const grant = stsToCosUploadGrant(head, files.map(() => crypto.randomUUID()));
 * ```
 */
export function stsToCosUploadGrant(
  sts: StsTmpKeysResponse,
  clientRefs: string[],
): CosUploadGrant {
  if (sts.tmp_key === '') {
    throw new Error('grantStsTmpKeyFiles 返回的 tmp_key 为空，请重试');
  }
  return {
    credentials: stsCredentialsToCosCredentials(sts),
    bucket: sts.bucket,
    region: sts.region,
    // caller 用 client_ref 提供：caller 持有 refetchIntents 闭包，refetch 时复用
    // 同一 client_ref，使 useCosUpload.applyFreshIntents 按 Map 索引命中；
    // 缺省时退回 transient UUID（仅适合不调 refetch 的场景，如 usePartBatchManual 的
    // 单次 getUploadGrant 路径；CosUploader 在该路径不主动 refetch）。
    items: clientRefs.map((client_ref) => ({
      client_ref,
      tmp_key: sts.tmp_key,
    })),
  };
}
