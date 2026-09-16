# PDF 与文件处理

> **目标读者**：新人 / Agent / 部署运维
> **核心价值**：PDF 渲染锚链、合并、文件上传、nginx 体积上限对齐的统一视图。
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

前端涉及 PDF / 大文件的核心组件、工具与运维约束都在这一篇收口。改动 PDF 渲染或上传体积上限前请通读全文。

## 1. PDF 渲染（锚链）

**所有 PDF 渲染必须从 `src/utils/pdfjs.ts` import `pdfjsLib`，严禁各自 `import 'pdfjs-dist'`。** 详细背景与配置细节见 [02-architecture/pdf-integration.md](../02-architecture/pdf-integration.md)。

`src/utils/pdfjs.ts` 的两个关键机制：

- **`workerSrc` 缓存穿透**：`PDF_WORKER_CACHE_BUST = 'v=20260719'`，追加为 `?v=20260719` 查询参数，强制浏览器绕过因 nginx `.mjs` MIME 配错导致的整年 immutable 缓存。今后若再遇类似缓存中毒，递增版本串即可。
- **CJK cMap**：`PDF_CMAP_OPTIONS = { cMapUrl, cMapPacked: true }` 在 `getDocument()` 时传入；`cMapUrl` 由 `import.meta.glob('/node_modules/pdfjs-dist/cmaps/*.bcmap', { query: '?url', import: 'default' })` 解析得到（中文 / 日文 PDF 必备）。

渲染组件：`src/components/PdfViewer.vue`（230 行）。所有需要预览 PDF 的页面（图纸 / 报价单 / 送货单等）都应通过该组件复用，不要重写。

## 2. PDF 合并 `mergePdfs.ts`

`src/utils/mergePdfs.ts` 用 `pdf-lib` 在浏览器端把多个 PDF Blob 按数组顺序合并成单个 PDF Blob：

```ts
import { mergePdfBlobs } from '@/utils/mergePdfs';

const merged = await mergePdfBlobs([pdfBlob1, pdfBlob2, pdfBlob3]);
```

典型用途：

- 批量打印：把同批次的图纸合并成一个 PDF 一次性下载。
- 图纸双面合并：把奇数页 / 偶数页拼成可双面打印的单文件。

抽离时间：2026-08-22，从 `PartsList.vue` 批量打印流程拆出，目的是瘦身 view + 让逻辑可单测。

单测：`src/utils/__tests__/mergePdfs.spec.ts`（验证页数累加、顺序保持、空数组 → 0 页 PDF 等）。`pdf-lib` 在 vitest node 环境直接可跑，无需浏览器。

## 3. 文件上传与下载

通用文件 API 与下载助手：

| 工具         | 路径                              | 作用                                           |
| ------------ | --------------------------------- | ---------------------------------------------- |
| 文件 API     | `src/api/file.ts`                 | 通用文件上传 / 下载 / 删除接口                 |
| 下载助手     | `src/utils/download.ts`           | 浏览器端触发 Blob 下载（`a.click()` + `Blob`） |
| 文件列表卡片 | `src/components/FileListCard.vue` | 通用文件列表展示 + 上传 / 预览 / 下载交互      |

新页面涉及文件上传时优先复用 `FileListCard.vue`，避免在每个 view 重复写 el-upload + 文件列表渲染逻辑。

### 3.1 COS 直传链路（2026-09-16 M3 新增）

图纸 / 3D 模型等大文件不再走 multipart 由后端代理上传 COS，改为：后端签发 STS 临时凭证 + tmp_key → 前端 cos-js-sdk-v5 直传 COS tmp 区 → 业务端点（建单 / 补传）携带 tmp_key + sha 由后端 head + copy 到正式 CAS key。

涉及的模块（自上而下）：

| 模块                             | 路径                                                                                | 作用                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| STS 凭证申请 + confirm（场景 B） | `src/api/parts/file.ts`                                                             | `createUploadIntents` / `confirmPartFile`                                       |
| JSON batch create（场景 A）      | `src/api/parts/batch.ts`                                                            | `batchCreateParts` items 含 `drawing_file?` / `model3d_file?` FileBinding       |
| COS 直传 composable              | `src/composables/useCosUpload.ts`                                                   | cos-js-sdk-v5 封装 + 凭证过期自动重签                                           |
| 流式 SHA-256 hash 工具           | `src/utils/fileHash.ts`                                                             | hash-wasm 8MB 分块，恒定内存                                                    |
| 类型契约                         | `src/types/part_file.ts`                                                            | `CosCredentials` / `UploadIntentsIn/Out` / `FileBinding` / `PartBatchCreateOut` |
| PartBatchPdfTab 集成             | `src/views/parts/components/PartBatchPdfTab.vue` + `composables/usePartBatchPdf.ts` | Tab 2「PDF 批量上传」改造为 COS 直传 + JSON batch                               |
| 行内进度 / 重试单元              | `src/components/UploadStatusCellView.vue`                                           | T3.4 复用 cell 显示组件                                                         |

#### COS 桶 CORS 配置（必读，运维首次部署必踩坑）

前端 cos-js-sdk-v5 直连 COS 桶域名（`{bucket}-{appid}.cos.{region}.myqcloud.com`），**不走** frontend nginx，因此 nginx 配置（仅反代 `/api/*`）不生效；CORS 必须**在 COS 控制台**「存储桶 → 权限管理 → 跨域访问 CORS 设置」显式开启：

- **来源 Origin**：
  - `http://localhost:8080`（dev 本地 nginx）
  - staging 域名
  - 生产域名
- **操作 Methods**：`PUT, POST, GET, HEAD, DELETE`（SDK 上传主要用 `PUT`）
- **允许 Headers**：`*`
- **暴露 Headers**：`ETag, x-cos-*`（上传完成后 SDK 要读 `ETag`）
- **超时秒数**：建议 ≥ 300（大文件分块耗时）

**没配 CORS 的表现**：浏览器报 `No 'Access-Control-Allow-Origin' header is present`，PUT 预检 403；前端上传组件表现为「上传中…」无限挂起，最终 SDK 内部 reject 抛 `TypeError: Failed to fetch`。

**配错位置**（曾踩）：腾讯云 COS 的 CORS 在「存储桶」级别设置，**不是**用户级 / 角色级；新桶默认无 CORS。

#### STS policy resource 与 tmp_key 模板对齐

后端 STS policy 的 resource 限定前缀：

- 场景 A（创建工单）：`tmp_sub_prefix = "{cfg_tmp_prefix}{Uuid::new_v4()}"` → 实 key 形如 `tmp/<batch_uuid>/<seq>_<sanitized_filename>`
- 场景 B（详情页补传）：`tmp_sub_prefix = "{cfg_tmp_prefix}part/{owner_id}"` → 实 key 形如 `tmp/part/<part_id>/<seq>_<sanitized_filename>`

前端 `useCosUpload` 直传时只需把后端返回的 `tmp_key` 原样填到 `cos.uploadFile({ Key: tmp_key })` —— 前端不需要自己拼 prefix。重签场景下若 `tmp_key` 变化，composable 内部的 `applyFreshIntents` 兜底（详见 `src/composables/useCosUpload.ts` 注释）会 reset status=pending 强制重传，不会让「旧 STS 写旧 key + 新 tmp_key 拿去 commit」的鬼状态穿透。

## 4. nginx 300m 上限对齐

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

为什么是 300m：批量 PDF 上传最大约 250m，300m 留出余量。修改该值需要前后端 + 部署同步对齐——前端上传组件按这个上限做了 UI 提示（`el-alert` warning），调小会导致已上线的批量上传任务突然失败，调大也会让 nginx 内存压力上升。

上传超限 nginx 直接返回 413，前端拦截器会把它当作业务错误抛 `ApiError(413, message)`，调用方按需提示用户压缩文件。

## 5. 文件类型清单

系统里出现的图纸 / 模型文件类型（与后端约定一致）：

| 编码              | 含义     | 典型格式          |
| ----------------- | -------- | ----------------- |
| `DRAWING`         | 图纸     | PDF               |
| `3D_MODEL`        | 3D 模型  | STEP / IGES / STL |
| `G_CODE`          | G 代码   | 数控加工程序      |
| `SETUP_SHEET`     | 设定单   | PDF               |
| `ASSEMBLY_MASTER` | 总装图   | PDF               |
| `CAD_2D`          | 二维 CAD | DWG / DXF         |

PDF 类型（`DRAWING` / `SETUP_SHEET` / `ASSEMBLY_MASTER`）走 `PdfViewer.vue` 直接预览；其他类型走通用下载链接。

新增文件类型时：

1. 后端枚举加值（`docs/api/` 同步更新）。
2. 前端类型枚举加值（通常在 `src/types/file.ts`）。
3. `FileListCard.vue` 的图标 / 预览分支补对应分支。
