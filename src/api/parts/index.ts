// 后端零件 API 聚合 —— 把 ./crud ./batch ./bid ./print 四个 `/parts/*` 子域，与
// 文件 / 打印子域（随 2026-10-13 后端 files 域重组迁至 ../files/objects）合并 re-export。
// 2026-08-25：原 1165 行 api/parts.ts 拆为 4 个子文件 + 本聚合文件。
// 兼容性：原 `import ... from '@/api/parts'` 由 `api/parts.ts`（兼容 shim）
// `export * from './parts/index'` 转发到此聚合文件，所有原有命名导出保持不变。
// ⚠️ 本聚合口仍跨 files 域 re-export：调用方（FileListCard / usePartBatchPdf 等）按
// 「零件相关文件」从 `@/api/parts` 一次取齐，无需知道它落在哪个子文件。

export * from './crud';
export * from './batch';
export * from './bid';
export * from './print';
export * from '../files/objects';
