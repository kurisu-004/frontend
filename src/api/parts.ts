// 2026-08-25 重构：原 1165 行 api/parts.ts 按 endpoint 域拆为 ./parts/ 子文件
// （crud / batch / bid / file + index 聚合）。本文件保留同名兼容路径，
// 所有原 `import ... from '@/api/parts'` 不需改动。
//
// 注：写 `./parts` 时 TypeScript Bundler 解析会先匹到 `parts.ts` 自身，导致
// 自循环（`parts.ts → parts.ts`），export 全空；写 `./parts/index` 强制指向
// 目录入口，行为才符合预期。
export * from './parts/index'