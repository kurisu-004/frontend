// 零件打印 BFF API（`/api/v2/parts/*` 的打印分支）—— 本文件是 `api/parts/` 下**纯
// 打 `/parts/*`** 的实现文件之一（另有 crud / batch / bid）。
//
// 归属说明：这两个端点虽是「出 PDF」，但语义是零件的图纸双面打印，路径与调用方
// （FileListCard 单件打印、useBatchPrint 批量打印）都属零件域，故住在 `api/parts/`
// 而不是 `api/files/`。文件对象域的实现在 `api/files/objects.ts`。
//
// 端点由 rust 鉴权后转发 python 生成 PDF，前端走 `api`（baseURL `/api/v2`），
// 响应消费方式（blob + 隐藏 iframe 打印）不变。

import { api } from '@/api/http';

/**
 * 生成零件的双面打印 PDF（图纸 + 反面右下角条形码）。
 * 返回 Blob，content-type=application/pdf。
 *
 * 注：返回的是文件 blob，调用方需自行用 iframe / window 触发打印。
 *
 * 2026-10-03：端点由 rust 鉴权后转发 python（`GET /api/v2/parts/{id}/print-drawing`），
 * 前端走 `api`。响应是 PDF blob，**文件名不消费**——单件打印由调用方把 blob 塞进隐藏
 * iframe 内联渲染，不落盘，因此用不到 `Content-Disposition`。
 */
export async function printPartDrawing(partId: string): Promise<Blob> {
  const resp = await api.get<Blob>(`/parts/${encodeURIComponent(partId)}/print-drawing`, {
    responseType: 'blob',
  });
  return resp.data;
}

/**
 * 批量生成多个零件的双面打印 PDF 并合并为一个 PDF（2026-07-17 接入）。
 * 后端把 N 个 part 的双面 PDF 顺序拼接成单文件返回。
 * 前端拿到 Blob 后用单 iframe 一次 print()，避免 N 次打印弹窗。
 *
 * 2026-10-03：端点由 rust 鉴权后转发 python（`POST /api/v2/parts/print-drawing-batch`）。
 * timeout 12 分钟：N 个 part 拼 PDF 耗时可达分钟级，**必须严格大于 rust 打印档的 660s**
 * 并留余量。两级超时串联时若浏览器先到点，只会抛一个无信息量的 ECONNABORTED，把 rust
 * 侧的真实诊断（转发层 600s 转发超时的 502 + 20407，或打印档 660s 请求中间件的
 * 408 + 40800）整个吃掉，排查时看不到任何服务端信号。
 */
export async function printPartDrawingBatch(
  partIds: string[],
  assemblyIds?: string[],
): Promise<Blob> {
  const resp = await api.post<Blob>(
    '/parts/print-drawing-batch',
    { part_ids: partIds, assembly_ids: assemblyIds },
    { responseType: 'blob', timeout: 12 * 60 * 1000 },
  );
  return resp.data;
}
