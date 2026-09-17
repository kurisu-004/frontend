# PDF 与文件处理

> **目标读者**：新人 / Agent / 部署运维
> **核心价值**：PDF 渲染锚链、PDF 合并、文件类型清单的统一视图
> **最后更新**：2026-09-17 · **维护者**：@frontend-team

---

文件上传 / COS 直传详见 [`cos-upload.md`](./cos-upload.md)

前端涉及 PDF / 大文件的核心组件、工具与运维约束都在这一篇收口。改动 PDF 渲染前请通读全文；COS 直传 / 通用上传组件请读 `cos-upload.md`。

## 1. PDF 渲染（锚链）

**所有 PDF 渲染必须从 `src/utils/pdfjs.ts` import `pdfjsLib`，严禁各自 `import 'pdfjs-dist'`。** 详细背景与配置细节见 [02-architecture/pdf-integration.md](../02-architecture/pdf-integration.md)。

`src/utils/pdfjs.ts` 的两个关键机制：

- **`workerSrc` 缓存穿透**：`PDF_WORKER_CACHE_BUST = 'v=20260719'`，追加为 `?v=20260719` 查询参数，强制浏览器绕过因 nginx `.mjs` MIME 配错导致的整年 immutable 缓存。今后若再遇类似缓存中毒，递增版本串即可。
- **CJK cMap**：`PDF_CMAP_OPTIONS = { cMapUrl, cMapPacked: true }` 在 `getDocument()` 时传入；`cMapUrl` 由 `import.meta.glob('/node_modules/pdfjs-dist/cmaps/*.bcmap', { query: '?url', import: 'default' })` 解析得到（中文 / 日文 PDF 必备）。

渲染组件：`src/components/PdfViewer.vue`。所有需要预览 PDF 的页面（图纸 / 报价单 / 送货单等）都应通过该组件复用，不要重写。

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

## 3. 文件类型清单

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
3. `PdfViewer.vue` 与预览组件按 `file_type` 加分支（如图片格式扩展名走 `el-image` 而非 PDF 解析）。
