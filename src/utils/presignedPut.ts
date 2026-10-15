// utils/presignedPut.ts —— 预签 PUT 直传（S3 / COS 签名 URL 的浏览器端执行器）
//
// 2026-10-15 新增：取代「STS 临时凭证 + cos-js-sdk-v5」那套上传实现。
//
// ## 为什么用 XMLHttpRequest 而不是 fetch
//
// 上传进度。`fetch` + `ReadableStream` 的上传进度在 Safari 上不可靠（要么不派发
// `progress` 事件，要么需要 request body 为可读流，从而丢掉 `File` 对象的原生流式
// 语义），而本仓的图纸预览 / 打印链路里 Safari 并不是可以忽略的现场。XHR 的
// `upload.onprogress` 是所有目标浏览器都稳定给出的那条通道。
//
// ## 为什么 Content-Type 必须原样回填
//
// 签发时 `content_type` 进了 SigV4 的 **SignedHeaders**（这是 S3/COS 预签的默认
// 行为）。签名是对「方法 + 路径 + query + 已签头集合」的 HMAC —— PUT 时少带或多带
// 一个 `Content-Type`，服务端算出的签名就与 URL 里的对不上 ⇒ 403
// SignatureDoesNotMatch。**改一个字节的 MIME 就足以让一次 300MB 的上传全部白跑**，
// 所以本函数不提供任何「自动纠正 content_type」的口子：上层只能把服务端给的原样传进来。
//
// ## 信任取舍：签名不绑内容哈希
//
// S3 / COS 预签 URL 默认用 `UNSIGNED-PAYLOAD`（签名头里的 payload 是常量
// `UNSIGNED-PAYLOAD` 而不是内容的 SHA-256）。也就是说：**URL 本身不证明 PUT 上去的
// 字节就是申请时声明的那份字节**。这带来一条明确的安全边界 ——
//
//   知道 URL 的人，在 URL 有效期内可以把**任意内容** PUT 到那个 object_key。
//
// 本仓接受这条取舍，理由：① 预签 URL 的生命周期是分钟级、且只能 PUT 到一个由后端
// 从 `sha256 + owner + kind` 派生的随机 key 上，拿到 URL 的人拿不到其它 key；
// ② 真正的内容校验落在 `confirm` —— 后端对已落盘对象做 head + 大小比对，业务行只在
// 校验通过后插入；③ 换成绑内容的签名（S3 支持 `x-amz-content-sha256` 参与签名）会
// 要求前端在浏览器里完整算一遍 SHA-256 才能发起 PUT，而本仓的 sha 已经在
// upload-intents 之前算过一次，再算一遍对 300MB 图纸是纯粹的用户可感知等待。
//
// ## URL 有效期到点怎么办
//
// `expires_at` 过了就是 403（签名过期）或 403（SignatureDoesNotMatch，取决于服务端
// 判定顺序）。**本地没有任何补救手段**，必须回后端重新调 upload-intents 换一枚新
// URL。本模块负责把这类失败**标出来**（`isPresignExpiredError`），由上层重签。

/** 一次预签 PUT 的参数。`contentType` 必须与服务端签发时给的字符串逐字相同。 */
export interface PresignedPutOptions {
  /** 完整的预签 URL（含 SigV4 query），原样使用，不要改写。 */
  url: string;
  /** Content-Type 原样回填 —— 它签在 SignedHeaders 里。 */
  contentType: string;
  /**
   * 本地推算的过期时刻（毫秒时间戳，由 `Date.now() + expires_in * 1000` 得出）。
   * **仅用于生成更准的报错文案**（区分「还没到点就被拒」与「到点才被拒」），不参与
   * 任何拦截逻辑 —— 时钟偏移下本地时间未必准，判定权交给服务端的状态码。
   */
  expiresAt?: number;
}

/** 失败时带在 Error 上的诊断信息。 */
export interface PresignedPutError extends Error {
  /** HTTP 状态码；网络中断 / CORS 被浏览器拦下时为 0。 */
  status: number;
  /** 响应体片段（截断到 512 字符）；网络中断时为空串。 */
  body: string;
  /**
   * 是否应触发「重新签发 URL 后重试」。判据 = 403 且响应体看起来是签名 / 过期问题
   * （`SignatureDoesNotMatch` / `Request has expired` / `AccessDenied`）。
   *
   * ⚠️ 只覆盖签名与过期两类：CORS 未配也是 403，但那种 403 **重签多少次都不会好**
   * （浏览器在拿到响应前就把请求掐了，body 为空），所以它落在这一支之外，按普通失败
   * 报出「请检查 COS 桶的跨域设置」。
   */
  presignExpired: boolean;
  /** 状态为 0（网络中断 / CORS 被浏览器拦截，浏览器拿不到任何响应）时为 true。 */
  networkOrCors: boolean;
}

/** 服务端对「签名不对 / 已过期」的几种措辞（COS 与 S3 各有说法，都收）。 */
const SIGNATURE_ERROR_PATTERNS: RegExp[] = [
  /SignatureDoesNotMatch/i,
  /Request has expired/i,
  /RequestTimeTooSkewed/i,
  /ExpiredToken/i,
  /InvalidAccessKeyId/i,
  /AccessDenied/i,
];

/**
 * 是否是「URL 过期 / 签名失效」这类**重签一次就能好**的 403。
 *
 * 与 CORS 未配（同样是 403）的分界靠响应体：CORS 被浏览器拦截时前端根本读不到响应
 * body（空串 + status 0），后端签发 CORS 未配时则返回 XML 错误体。
 */
export function isPresignExpiredError(e: unknown): boolean {
  return (e as PresignedPutError | null)?.presignExpired === true;
}

/** 状态码 0 = 浏览器没拿到任何响应（DNS / 连接中断 / 预检被 CORS 拦下）。 */
function isNetworkOrCors(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { status?: number; code?: string };
  if (err.status === 0) return true;
  return typeof err.code === 'string' && /network|cors/i.test(err.code);
}

/** 拼一条人可读的失败文案：状态码 + 响应体片段 + 一条可执行的排查建议。 */
function buildErrorMessage(status: number, body: string, url: string): string {
  const brief = body.replace(/\s+/g, ' ').trim().slice(0, 512);
  const where = url.split('?')[0] ?? url;
  if (status === 0) {
    return (
      `上传未送达对象存储（没有收到任何响应）：多半是网络中断，或对象存储桶未配置跨域` +
      `（PUT / 预检被浏览器拦下）。目标对象：${where}`
    );
  }
  if (status === 403) {
    return (
      `对象存储拒绝写入（403）：${brief || '（响应体为空，多半是桶未配置 CORS）'}。` +
      `目标对象：${where}`
    );
  }
  return `上传失败（HTTP ${status}）：${brief || '（响应体为空）'}。目标对象：${where}`;
}

/**
 * 用预签 URL 直传一个文件到对象存储。
 *
 * 成功 resolve（无返回值 —— 上传结果由 confirm 端点登记，不靠这里回读什么）。
 * 失败 reject 一个 `PresignedPutError`：`status` / `body` / `presignExpired` /
 * `networkOrCors` 四个诊断字段都在，供上层区分「重签可救」与「要人介入」。
 *
 * `onProgress` 回抛 0-100 的整数百分比（`upload.onprogress` 的 `loaded / total`）。
 * 不可读总量（`total` 为 0，个别环境在 multipart 分块上传时会出现）时退化为「只涨不
 * 跳到 100」的推进值，保证进度条仍在动。
 */
export function xhrPut(
  opts: PresignedPutOptions,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.open('PUT', opts.url, true);
    // ⚠️ 原样回填：这一行参与服务端签名比对，**不允许**做任何「按扩展名纠正」之类的处理。
    xhr.setRequestHeader('Content-Type', opts.contentType);

    xhr.upload.onprogress = (e: ProgressEvent): void => {
      if (!onProgress) return;
      if (e.lengthComputable && e.total > 0) {
        onProgress(Math.round((e.loaded / e.total) * 100));
        return;
      }
      // 总量未知：给一个「只涨不封顶」的推进值，至少让 UI 知道字节在动。
      onProgress(Math.min(99, Math.round(e.loaded / 1024 / 1024)));
    };

    xhr.onload = (): void => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
        return;
      }
      const body = typeof xhr.responseText === 'string' ? xhr.responseText : '';
      const expired =
        xhr.status === 403 && SIGNATURE_ERROR_PATTERNS.some((re) => re.test(body));
      const err: PresignedPutError = Object.assign(
        new Error(buildErrorMessage(xhr.status, body, opts.url)),
        {
          status: xhr.status,
          body,
          presignExpired: expired,
          networkOrCors: false,
        },
      );
      reject(err);
    };

    xhr.onerror = (): void => {
      // 走到这里说明浏览器**没有拿到任何响应**：连接被掐、DNS 失败、或 CORS 预检被拦。
      const err: PresignedPutError = Object.assign(
        new Error(buildErrorMessage(0, '', opts.url)),
        { status: 0, body: '', presignExpired: false, networkOrCors: true },
      );
      reject(err);
    };

    xhr.ontimeout = (): void => {
      const err: PresignedPutError = Object.assign(
        new Error(buildErrorMessage(0, '', opts.url)),
        { status: 0, body: '', presignExpired: false, networkOrCors: true },
      );
      reject(err);
    };

    xhr.onabort = (): void => {
      const err: PresignedPutError = Object.assign(
        new Error('上传已取消'),
        { status: 0, body: '', presignExpired: false, networkOrCors: false },
      );
      reject(err);
    };

    try {
      xhr.send(file);
    } catch (e) {
      // send 同步抛错（极少见：URL 非法、File 已被回收）：也归到「没送达」那一支。
      reject(
        isNetworkOrCors(e)
          ? (Object.assign(new Error(buildErrorMessage(0, '', opts.url)), {
              status: 0,
              body: '',
              presignExpired: false,
              networkOrCors: true,
            }) as PresignedPutError)
          : (e instanceof Error ? e : new Error(String(e))),
      );
    }
  });
}
