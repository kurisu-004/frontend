// 后端零件 API 聚合 —— 把 ./crud ./batch ./bid ./file 四个子域合并 re-export。
// 2026-08-25：原 1165 行 api/parts.ts 拆为 4 个子文件 + 本聚合文件。
// 兼容性：原 `import ... from '@/api/parts'` 由 `api/parts.ts`（兼容 shim）
// `export * from './parts'` 转发到此聚合文件，所有原有命名导出保持不变。

export * from './crud'
export * from './batch'
export * from './bid'
export * from './file'