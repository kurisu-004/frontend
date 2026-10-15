// utils/cosSdk.ts
//
// 2026-10-21 新增：cos-js-sdk-v5 的**懒加载 + memo** 单点入口。
//
// 为什么要它：`cos-js-sdk-v5` 约 175KB，而两个上传 composable
// （`composables/useCosUpload.ts` 与 `components/CosUploader/useCosUploader.ts`，
// 仓内刻意保持的平行拷贝）都被零件详情页 / 零件批量上传页**静态**引用 ⇒ 这两个页面
// 的进页面静态闭包里各白坐着 175KB，尽管 SDK 只在用户真的上传文件时才需要。
// 把 `new COS()` 留在原地、只把 import 挪进函数体即可解决，但**不要**在两个 composable
// 里各写一份 `await import('cos-js-sdk-v5')` —— 那会让本文件的第三段那个坑变成两处。
//
// ⚠️ 第三段：为什么必须 memo（这条是踩出来的，不是洁癖）
//
//   vitest 的 `vi.mock('cos-js-sdk-v5', factory)` 对**运行期反复发生的动态 import**
//   并不稳定：实测同一个测试里第 1 次 `await import('cos-js-sdk-v5')` 命中桩
//   （`MockCOS`），第 2 次却绕过桩拿到**真 SDK** —— 真 SDK 会真的对
//   `bucket-*.cos.*.myqcloud.com` 发 PUT（happy-dom 拦不住），症状是上传态永远
//   不落地 + 控制台刷 CORS 报错，而失败信息里没有任何一条指向「mock 没生效」。
//   `server.deps.inline: ['cos-js-sdk-v5']` 实测**不能**治它（第二次调用照样拿真 SDK）。
//   memo 之后整个进程只发生一次 `import()`，第一条永远命中桩，两条上传 spec 的桩随之
//   稳定（`useCosUpload.spec.ts` / `useCosUploader.spec.ts`）。
//
// 失败时把 memo 清掉（见下）：不能把 rejected promise 永久缓存住，那会让「第一次上传
// 时网络抖了一下」变成整个会话内上传永久不可用且不再重试。
//
// 该包是 `export = COS`（CJS 形态），动态 import 拿到的是命名空间，取 `.default`
// 才是那个类。类型面走 `import type`，两者同源、构造签名逐字一致。

import type COS from 'cos-js-sdk-v5';

/** 已 memo 的加载结果；失败时置回 null 让下次调用重试。 */
let sdk: Promise<typeof COS> | null = null;

/** 取 cos-js-sdk-v5 的构造函数（`new COS({...})`）。整个进程只会真的 import 一次。 */
export function loadCosSdk(): Promise<typeof COS> {
  if (!sdk) {
    sdk = import('cos-js-sdk-v5')
      .then((mod) => mod.default)
      .catch((e) => {
        sdk = null;
        throw e;
      });
  }
  return sdk;
}
