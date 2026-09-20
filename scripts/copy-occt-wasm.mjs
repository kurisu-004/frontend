// 2026-09-20 新增：把 occt-wasm 包的 .wasm + .js 复制到 public/，vite 直接从根路径读取
//
// 移植自 ~/Code/step-viewer/scripts/copy-occt-wasm.mjs；
// 输出根改为 frontend 子模块根（`frontend/public/`），保留同样的文件名（occt-wasm.wasm / occt-wasm.js）。
//
// 触发：`npm install` 时由 package.json 的 postinstall 钩子调用。
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..'); // scripts/ → frontend/

const srcDir = resolve(root, 'node_modules/occt-wasm/dist');
const dstDir = resolve(root, 'public');

mkdirSync(dstDir, { recursive: true });

const files = ['occt-wasm.wasm', 'occt-wasm.js'];
let allCopied = true;
for (const name of files) {
  const src = resolve(srcDir, name);
  const dst = resolve(dstDir, name);
  if (!existsSync(src)) {
    console.error(`[copy-occt-wasm] missing: ${src}`);
    allCopied = false;
    continue;
  }
  copyFileSync(src, dst);
  console.log(`[copy-occt-wasm] ${src} -> ${dst}`);
}

if (!allCopied) {
  console.error('[copy-occt-wasm] FAIL: occt-wasm dist 文件缺失，请先 npm install occt-wasm');
  process.exit(1);
}
