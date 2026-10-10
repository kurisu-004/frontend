// 后端零件 API 聚合 —— 把 ./crud ./batch ./bid 三个子域 + 文件/打印子域
// （已随 2026-10-13 后端 files 域重组迁至 ../files/objects）合并 re-export。
// 2026-08-25：原 1165 行 api/parts.ts 拆为 4 个子文件 + 本聚合文件。
// 兼容性：原 `import ... from '@/api/parts'` 由 `api/parts.ts`（兼容 shim）
// `export * from './parts'` 转发到此聚合文件，所有原有命名导出保持不变。
// ⚠️ 2026-10-13：`./file` 已不存在，改从 `../files/objects` re-export，
// 以免 `printPartDrawing` / `uploadPartDrawing` 等（调用方 import 的是
// `@/api/parts` 这个聚合口）在本 PR 就断掉。后端 PR1b 合并上传端点后，
// 应重新评估这几个函数是否还该从这里导出。

export * from './crud';
export * from './batch';
export * from './bid';
export * from '../files/objects';
