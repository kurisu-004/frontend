# COS 上传（STS 前端直传）

> **目标读者**：新人 / Agent / 部署运维（需要在项目里加新场景的文件上传功能）
> **核心价值**：通用 COS 上传组件的对外契约、底层 composable、COS 直传链路细节、运维约束
> **最后更新**：2026-09-17 · **维护者**：@frontend-team

---

## 1. 概述

项目自 2026-09-16 M3 起把图纸 / 3D 模型等大文件从「multipart 后端代理上传 COS」改造为「STS 前端直传 COS tmp 区 + 业务端点 confirm / batch」两段式链路，目的是绕开后端带宽瓶颈并支持前端进度反馈。M3-A / M3-B / M3-C 三轮把 part-file 域的 `PartBatchPdfTab` 与详情页补传跑通后，2026-09-17 启动 M4 把上传链路进一步抽象为域无关的 `CosUploader.vue` + `useCosUploader.ts` + `src/types/cos_upload.ts` 三件套，让新业务域（外协 / 品检 / 扫码台等）零成本复用，不依赖 part-file 任何类型与端点。`part-file` 域既有专用链路（`useCosUpload` / `usePartFileUpload` / `FileListCard` / `PartBatchPdfTab`）保持稳定运行，与新通用链路并存（详见 §8）。

## 2. 通用上传组件 `CosUploader.vue`

通用上传壳组件，封装「选文件 → 算 hash（可选）→ 申请 STS 凭证 → 直传 COS → 调用 caller 注入的 confirm 回调」全流程，并暴露细粒度状态 / 重试 / 清空等命令式接口。

### 2.1 Props

| 名称            | 类型                                          | 必填 | 默认值                                        | 说明                                                                                             |
| --------------- | --------------------------------------------- | ---- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `requestUpload` | `(file: File) => Promise<CosUploadSession>`   | 是   | —                                             | 单文件申请 STS 凭证 + tmp_key；caller 注入，与业务端点解耦                                       |
| `confirm`       | `(item: CosUploadedItem) => Promise<unknown>` | 否   | `undefined`                                   | 单文件上传完成后由组件自动调用；返回业务侧结果（如 `PartFileItem`）                              |
| `cancel`        | `(item: CosUploadedItem) => Promise<void>`    | 否   | `undefined`                                   | 用户主动取消某 item 时由组件回调；caller 负责清理后端 tmp 对象                                   |
| `accept`        | `string`                                      | 否   | `'*/*'`                                       | `el-upload` 的 accept 属性，控制文件选择对话框类型                                               |
| `multiple`      | `boolean`                                     | 否   | `false`                                       | 是否允许多选；多选时 `requestUpload` 会并发触发                                                  |
| `limit`         | `number`                                      | 否   | `Infinity`                                    | 最大文件数；超出时 `el-upload` onExceed 触发                                                     |
| `maxSizeMB`     | `number`                                      | 否   | `300`                                         | 单文件上限（与 nginx `client_max_body_size 300m` 对齐）；超出组件层拦截                          |
| `disabled`      | `boolean`                                     | 否   | `false`                                       | 全局禁用（按钮置灰 + 拒绝拖拽）                                                                  |
| `autoUpload`    | `boolean`                                     | 否   | `true`                                        | `false` 时仅入队不自动 startUpload，由 caller 调 `startUpload()` 命令式触发                      |
| `computeHash`   | `(file: File) => Promise<string>`             | 否   | `undefined`                                   | 流式 SHA-256；组件把它放在上传前同步执行，结果附在 item 上传给 `requestUpload`（用于后端 dedup） |
| `concurrency`   | `number`                                      | 否   | `3`                                           | 最大并发上传文件数（对齐 SDK 默认 `FileParallelLimit`）                                          |
| `tip`           | `string`                                      | 否   | `'支持 PDF / 图片 / 3D 模型，单文件 ≤ 300MB'` | 组件底部提示文案                                                                                 |

### 2.2 Events

| 事件名     | 回调签名                                           | 触发时机                                           |
| ---------- | -------------------------------------------------- | -------------------------------------------------- |
| `change`   | `(items: CosUploaderItem[]) => void`               | 用户选 / 删 / 重试了 item 时                       |
| `uploaded` | `(result: unknown, item: CosUploaderItem) => void` | 单文件 confirm 成功后（`confirm` 回调 resolve 时） |
| `all-done` | `(items: CosUploaderItem[]) => void`               | 所有 item 都进入终态（done / error）时             |
| `error`    | `(err: Error, item: CosUploaderItem) => void`      | 单文件上传或 confirm 失败时                        |

### 2.3 Exposes

| 名称          | 类型                                   | 说明                                                   |
| ------------- | -------------------------------------- | ------------------------------------------------------ |
| `items`       | `Ref<CosUploaderItem[]>`               | 当前上传队列（响应式），可直接在父级 `v-for` 渲染      |
| `startUpload` | `() => Promise<void>`                  | 命令式触发整批上传（仅当 `autoUpload=false` 时需要）   |
| `retryItem`   | `(clientRef: string) => Promise<void>` | 单项重试（status=error → pending → 重传 → 重 confirm） |
| `removeItem`  | `(clientRef: string) => void`          | 移除某 item（若已上传会先调 `cancel` 回调）            |
| `clear`       | `() => void`                           | 清空整个队列（不触发 cancel，由 caller 自管）          |
| `allDone`     | `ComputedRef<boolean>`                 | 所有 item 进入终态                                     |
| `allOk`       | `ComputedRef<boolean>`                 | 所有 item status=done                                  |

### 2.4 用法示例

#### a) 最小接入（只传 `requestUpload`，无 confirm 无 hash）

适用场景：纯展示上传进度，不需要 dedup，不需要业务 confirm 端点（上传完即结束）。

```vue
<script setup lang="ts">
import { ref } from 'vue';
import CosUploader from '@/components/CosUploader.vue';
import type { CosUploadSession } from '@/types/cos_upload';
import { api } from '@/api/http';

const itemsRef = ref<unknown[]>([]);

// caller 只需注入一个 requestUpload：调后端拿 STS + tmp_key
async function requestUpload(file: File): Promise<CosUploadSession> {
  // 这里走任意后端端点（caller 自定义）；单文件场景下 items 只放一项
  const clientRef = crypto.randomUUID();
  const { data } = await api.post<{
    credentials: CosCredentials;
    bucket: string;
    region: string;
    tmp_key: string;
  }>('/my-domain/upload-intents', {
    filename: file.name,
    file_size: String(file.size),
    content_type: file.type,
  });
  return {
    credentials: data.credentials,
    bucket: data.bucket,
    region: data.region,
    items: [{ client_ref: clientRef, tmp_key: data.tmp_key }],
  };
}
</script>

<template>
  <CosUploader :request-upload="requestUpload" multiple :limit="10" />
</template>
```

#### b) 完整接入（`requestUpload` + `confirm` + `cancel` + `computeHash`）

适用场景：需要后端 dedup 命中时复用旧文件、需要 confirm 落业务表、需要清理 tmp 区。

```vue
<script setup lang="ts">
import { ref } from 'vue';
import CosUploader from '@/components/CosUploader.vue';
import type { CosUploadedItem, CosUploadSession } from '@/types/cos_upload';
import { api } from '@/api/http';
import { computeSha256 } from '@/utils/fileHash';

interface MyFileItem {
  id: string;
  filename: string;
}

// 1. 申请 STS + tmp_key（业务端点）
async function requestUpload(file: File, contentSha256: string): Promise<CosUploadSession> {
  const { data } = await api.post<CosUploadSession>('/my-domain/upload-intents', {
    filename: file.name,
    file_size: String(file.size),
    content_type: file.type,
    content_sha256: contentSha256,
  });
  return data;
}

// 2. confirm 回调：让后端 head + copy tmp → 正式 CAS key + 落库
async function confirm(item: CosUploadedItem): Promise<MyFileItem> {
  const { data } = await api.post<MyFileItem>('/my-domain/files/confirm', {
    tmp_key: item.tmp_key,
    content_sha256: item.sha256,
    original_filename: item.file.name,
    file_size: String(item.file.size),
    content_type: item.file.type,
  });
  return data;
}

// 3. cancel 回调：用户主动取消时清理后端 tmp 对象（可选）
async function cancel(item: CosUploadedItem): Promise<void> {
  await api.post('/my-domain/upload-cancel', { tmp_key: item.tmp_key });
}

const uploaderRef = ref<InstanceType<typeof CosUploader>>();

function onAllDone() {
  // 全部上传完（含 finish + 错误），UI 可关闭 / 跳列表
}
</script>

<template>
  <CosUploader
    ref="uploaderRef"
    :request-upload="requestUpload"
    :confirm="confirm"
    :cancel="cancel"
    :compute-hash="computeSha256"
    multiple
    :limit="20"
    :max-size-m-b="300"
    @all-done="onAllDone"
  />
</template>
```

## 3. 底层 composable `useCosUploader.ts`

适用于「不需要组件 UI、只想要上传逻辑」的场景：自渲染列表（如内嵌在表格行内）、批量上传脚本、vitest 单测。与 `useCosUpload`（part-file 专用）的区别：`useCosUploader` 完全解耦，不 import `src/types/part_file.ts`，状态机更克制（不内嵌 hash + confirm，纯直传），confirm / cancel 都由 caller 注入。

**何时直接用 composable 不要 UI**：

- 自渲染列表场景（如每行一个上传按钮 + 进度条）
- 批量上传脚本（如 `vite-node scripts/batch-upload.ts`）
- vitest 测试（不需要挂载组件）

**状态机**：

```
pending ──> hashing(可选,computeHash 异步) ──> uploading ──> done
                                                  │
                                                  └──> error ──(retryItem)──> pending
```

**签名**：

```ts
const {
  items,        // Ref<CosUploaderItem[]>（原地修改 status/progress/error/etag/contentSha256）
  startUpload,  // () => Promise<void>   整批启动
  retryItem,    // (clientRef: string) => Promise<void>
  removeItem,   // (clientRef: string) => void
  allDone,      // ComputedRef<boolean>  所有项进入终态
  allOk,        // ComputedRef<boolean>  所有项 status=done
} = useCosUploader({
  requestUpload: async (file: File, contentSha256?: string) => { ... },
  concurrency?: number, // 默认 3
});
```

**凭证过期自动重签策略**：每文件直传前 composable 内部检测 `(Date.now() + 5 * 60_000) >= expired_time * 1000` 是否成立，任意一项即将过期即整批调用 `requestUpload` 重新签发。**若 caller 重新签发后某 item 的 `tmp_key` 发生变化**，`useCosUploader` 内部的兜底机制（与 `useCosUpload.applyFreshIntents` 同源）会强制把该 item 的 status 复位为 `pending`，清空 progress / etag / error，下次 `startUpload` / `retryItem` 重新拉起上传，避免「旧 STS 写到旧 key + 新 tmp_key 拿去 confirm」的鬼状态穿透。

**并发控制**：默认 `concurrency=3`（对齐 cos-js-sdk-v5 默认 `FileParallelLimit`）；如需调整传 `concurrency` 参数；并发实现为简易信号量 worker 池，单文件内部切片由 SDK 自动处理。

**域解耦**：composable 不 import `src/types/part_file.ts`，仅依赖 `src/types/cos_upload.ts` 与 `cos-js-sdk-v5` / `hash-wasm`（可选）。

## 4. 类型契约 `src/types/cos_upload.ts`

域无关的纯类型层，零业务字段：

| 类型                | 用途                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CosCredentials`    | STS 临时凭证四元组（`tmp_secret_id` / `tmp_secret_key` / `session_token` / `expired_time`），直接喂给 `new COS({...})`                                                                      |
| `CosUploadSession`  | `requestUpload` 回调返回的统一形状（`credentials` + `bucket` + `region` + `items: Array<{ client_ref; tmp_key }>`），caller 自定 `items` 内字段名（仅 `client_ref` / `tmp_key` 是固定必须） |
| `CosUploadedItem`   | 上传完成后的对外输出（`client_ref` + `tmp_key` + 可选 `etag` + `file` + 可选 `sha256`），`confirm` 回调入参与 `uploaded` 事件 payload                                                       |
| `CosUploaderStatus` | 状态机五态：`pending` / `hashing` / `uploading` / `done` / `error`                                                                                                                          |
| `CosUploaderItem`   | 组件内部 item（`extends CosUploadedItem` + `status` + `progress` + `error`），运行时状态机                                                                                                  |

所有 id 字段保持 `string`（雪花 ID 不丢精度原则，详见仓库根 `CLAUDE.md` §硬约束 #3）。

## 5. COS 直传链路细节

### 5.1 STS policy resource 与 tmp_key 模板对齐

后端 STS policy 的 `resource` 限定了允许写入的前缀，前端**只填 `tmp_key`，不需要自己拼 prefix**。后端会根据场景动态生成前缀：

- **场景 A（创建工单 / 批量提交）**：`tmp_sub_prefix = "{cfg_tmp_prefix}{Uuid::new_v4()}"`，实际 key 形如 `tmp/<batch_uuid>/<seq>_<sanitized_filename>`
- **场景 B（详情页补传）**：`tmp_sub_prefix = "{cfg_tmp_prefix}<owner_kind>/<owner_id>"`，实际 key 形如 `tmp/<owner_kind>/<owner_id>/<seq>_<sanitized_filename>`（part-file 域用 `tmp/part/<part_id>/...`）

`CosUploader` / `useCosUploader` 把 `requestUpload` 返回的 `tmp_key` 原样塞进 `cos.uploadFile({ Key: tmp_key })`，composable 内部不再做 prefix 处理。**重签场景下若 `tmp_key` 变化**，composable 内部的兜底机制（与 `useCosUpload.applyFreshIntents` 同源）会 reset pending 强制重传——详见 §3。

### 5.2 凭证过期与自动重签

策略：在每次 `startUpload` / `retryItem` 真正发起上传前，composable 检查「当前任一 item 的 STS 凭证是否即将过期」，判定公式：

```
now_ms + 5 * 60_000 >= credentials.expired_time * 1000
```

命中则整批调 `requestUpload` 重签。提前 5 分钟触发是为了覆盖「上传一个大文件本身就要几十分钟」的场景，避免在 90% 进度时凭证失效导致 SDK 内部 reject。

**最大有效期**：后端 STS 凭证默认 900 秒（15 分钟）；前端检测到即将过期自动重签，对调用方完全透明。运维如调整 `expired_time` 上限需同步告知前端（一般无需关心）。

### 5.3 COS 桶 CORS 配置（运维必读）

前端 cos-js-sdk-v5 直连 COS 桶域名（`{bucket}-{appid}.cos.{region}.myqcloud.com`），**不走** frontend nginx；因此 nginx 反代配置（仅 `/api/*`）对上传请求不生效，CORS **必须在 COS 控制台**显式开启。

**配错位置警告**：

- 正确位置：COS 控制台 → 存储桶列表 → 进入目标桶 → 权限管理 → 跨域访问 CORS 设置 → 添加规则
- 错误位置：用户级 / 角色级 IAM 设置（无效）

**配置项**：

| 字段         | 取值                                                                                                       | 说明                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 来源 Origin  | dev / staging / 生产域名（如 `http://localhost:5173` / `https://staging.xxx.com` / `https://www.xxx.com`） | dev 本地 Vite 端口也要单独加                 |
| 操作 Methods | `PUT, POST, GET, HEAD, DELETE`                                                                             | SDK 上传主要用 `PUT`                         |
| 允许 Headers | `*`                                                                                                        | SDK 会携带 `x-cos-security-token` 等自定义头 |
| 暴露 Headers | `ETag, x-cos-*`                                                                                            | 上传完成后 SDK 读 ETag 落库                  |
| 超时秒数     | `≥ 300`                                                                                                    | 大文件分块耗时                               |

**没配 CORS 的表现**：浏览器 DevTools Network 报 `No 'Access-Control-Allow-Origin' header is present`，PUT 预检 403；前端上传组件表现为「上传中…」无限挂起，最终 SDK 内部 reject 抛 `TypeError: Failed to fetch`。**联调首日必踩**，请提前在 COS 控制台配好。

## 6. nginx 300m 上限对齐

`nginx.conf` 关键配置：

```nginx
location ^~ /api/v2/ {
    client_max_body_size    300m;
    ...
}

location /api/ {
    ...
    client_max_body_size       300m;
    ...
}
```

为什么是 300m：批量 PDF 上传最大约 250m，300m 留出余量。`CosUploader` 的 `maxSizeMB` 默认值与该上限对齐（前端 UI 用 `el-alert` warning 提示「单文件 ≤ 300MB」）。修改该值需要前后端 + 部署同步对齐——调小会导致已上线的批量上传任务突然失败，调大也会让 nginx 内存压力上升。

上传超限 nginx 直接返回 413，前端拦截器会把它当作业务错误抛 `ApiError(413, message)`，组件按需提示用户压缩文件。

## 7. 文件上传与下载通用工具

除 `CosUploader` 之外的通用辅助：

| 工具         | 路径                              | 作用                                                                                             |
| ------------ | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| 文件 API     | `src/api/file.ts`                 | 通用文件上传 / 下载 / 删除端点（与 CosUploader 解耦，caller 可直接用 axios 调任意业务 endpoint） |
| 下载助手     | `src/utils/download.ts`           | 浏览器端触发 Blob 下载（`a.click()` + `URL.createObjectURL`）                                    |
| 文件列表卡片 | `src/components/FileListCard.vue` | 通用文件列表展示 + 上传 / 预览 / 下载交互                                                        |

**注意**：`FileListCard.vue` 当前强绑 part-file 域（`apiUpload` 签名固定为 `(ownerId, file) => Promise<PartFileItem>`，且 props 类型直接引用 `PartFileItem` / `PartFileKind`），并不是真正的「域无关」通用组件。未来可迁移到内部使用 `CosUploader` 作为上传底座（解耦 part-file 类型）；迁移前不应用于非 part-file 场景。**新场景优先用 `CosUploader` + `useCosUploader`**。

## 8. 与 part-file 专用链路的关系

两套链路并存，互不依赖：

| 维度       | 通用链路（新）                             | part-file 专用链路（旧）                                             |
| ---------- | ------------------------------------------ | -------------------------------------------------------------------- |
| 组件       | `CosUploader.vue`                          | `FileListCard.vue` / `PartBatchPdfTab.vue`                           |
| composable | `useCosUploader.ts`                        | `useCosUpload.ts` / `usePartFileUpload.ts`                           |
| 类型契约   | `src/types/cos_upload.ts`                  | `src/types/part_file.ts`                                             |
| 端点       | caller 注入（`requestUpload` / `confirm`） | `src/api/parts/file.ts` 的 `createUploadIntents` / `confirmPartFile` |
| 域绑定     | 零业务字段，任意 caller 可复用             | 强绑 part-file `PartFileKind` / `Owner_part_id`                      |

**决策树**：

- **新业务域**（外协 / 品检 / 扫码台 / 报价等需要新上传场景） → 用 `CosUploader` + `useCosUploader` + `src/types/cos_upload.ts`，零 part-file 依赖
- **现有 part-file 补传 / 批量上传** → 保留旧链路（`FileListCard` + `usePartFileUpload` / `useCosUpload` + `PartBatchPdfTab`），已稳定运行且经过 M3 三轮联调验证
- **何时迁移旧链路到 `CosUploader`** → 待评估 `FileListCard` 解耦 cost 与收益后决定，作为后续 TODO；当前不强制迁移，避免无谓改动引入回归

## 9. 已知风险与决策记录

- **2026-09-17 决策**：组件只负责直传 + 进度管理，**endpoint 完全由 caller 注入**（`requestUpload` / `confirm` / `cancel`），不在组件内部 hardcode 任何业务端点。这一约束让 `CosUploader` 可以零修改地服务 part-file / 外协 / 品检 / 任何新域，避免历史上 `FileListCard` 强绑 part-file 类型导致复用困难的复发。
- **MVP 验证**：最小闭环见独立仓库 `~/Code/mvp-COS`（Vite + 独立 STS 后端 + 一个上传按钮）。MVP 仅验证 cos-js-sdk-v5 + STS 直传链路本身，不依赖本仓库业务端点；联调本仓库时务必在 COS 控制台按 §5.3 配好 CORS。
- **暂未覆盖**：服务端签名 `expired_time` 缩短到 300 秒以下的极端场景下，重签频率会显著上升但不会出错。如确需优化可在 `useCosUploader` 暴露 `expiryAheadMs` 参数（当前硬编码 5 分钟）。
