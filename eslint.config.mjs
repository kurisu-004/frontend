// 2026-09-13 接入 ESLint v9 flat config + 腾讯 AlloyTeam 规范（vue + typescript preset）
// 桥接策略：alloy v5.x 只导出 legacy .eslintrc 预设，通过 @eslint/eslintrc 的 FlatCompat
// 转换为 flat config 数组，保持 eslint.config.mjs 文件形态。
//
// 与 CLAUDE.md 硬约束的对齐：
//   #4  EP 命令式 API CSS 必须手动 import → 放行 element-plus/theme-chalk/*.css
//   #5  vite.config.ts optimizeDeps.include 不能动 → 配置文件单独分块，关 no-console
//   #6  pdfjs 必须从 @/utils/pdfjs 统一导入 → no-restricted-imports 限制裸 pdfjs-dist
//   #10 useLazyDraggable 模式 → 放行 vue-draggable-plus
//   #13 h() 函数 children 用法 → 不加 vue/no-restricted-syntax 一刀切

import vueParser from 'vue-eslint-parser';
import tsParser from '@typescript-eslint/parser';
import { FlatCompat } from '@eslint/eslintrc';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

// 注意 flat config 顺序：后写的覆盖前写的。
// alloy/vue 和 alloy/typescript 的 extends 块都包含全局 languageOptions.parser，
// 后面专门加的 files-constrained 块负责按文件类型恢复正确 parser。
export default [
  // 1. ignore 列表：产物目录、unplugin 生成文件、构建脚本
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'public/**',
      'scripts/**',
      '**/*.min.js',
      'src/auto-imports.d.ts', // unplugin-auto-import 生成
      'src/components.d.ts', // unplugin-vue-components 生成
    ],
  },

  // 2. alloy 规则全集（vue + typescript）—— 顺序无所谓，仅导入 plugin/rules
  //    不能放在 .vue / .ts 块前面，因为 compat.extends 会展开成多个 config 对象，
  //    全局 parser 会"传染"到后续所有文件类型匹配。
  ...compat.extends('eslint-config-alloy/vue'),
  ...compat.extends('eslint-config-alloy/typescript'),

  // 2.5 2026-09-13 补 alloy 默认未配的下划线豁免：本仓库习惯用 `_x` 标记故意未使用
  // （如 catch 忽略、回调占位、未用参数），避免被误报为未使用。
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // 3. .vue 文件：vue-eslint-parser 外层 + TS 内层
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tsParser,
        extraFileExtensions: ['.vue'],
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // CLAUDE.md #6：禁止裸 pdfjs-dist，必须走 @/utils/pdfjs
      // worker 子路径仅在 @/utils/pdfjs.ts 内部使用，需留口子
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'pdfjs-dist',
              message: '请通过 @/utils/pdfjs 统一导入 pdfjs（CLAUDE.md #6）',
            },
          ],
          patterns: [
            {
              group: ['pdfjs-dist/*', '!pdfjs-dist/build/pdf.worker.min.mjs'],
              message:
                '请通过 @/utils/pdfjs 统一导入 pdfjs（CLAUDE.md #6）。worker 子路径仅在 @/utils/pdfjs.ts 内部允许',
            },
          ],
        },
      ],
    },
  },

  // 4. .ts / .tsx 文件：TS parser
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // 与 .vue 块保持一致
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'pdfjs-dist',
              message: '请通过 @/utils/pdfjs 统一导入 pdfjs（CLAUDE.md #6）',
            },
          ],
          patterns: [
            {
              group: ['pdfjs-dist/*', '!pdfjs-dist/build/pdf.worker.min.mjs'],
              message:
                '请通过 @/utils/pdfjs 统一导入 pdfjs（CLAUDE.md #6）。worker 子路径仅在 @/utils/pdfjs.ts 内部允许',
            },
          ],
        },
      ],
    },
  },

  // 5. 单测文件：宽松规则（避免 baseline 误报）
  {
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // 2026-09-16 新增：单测里大量「const items = ref([...])；items.value.every(...)」
      // 模式，rule 把所有 ref.value 同作用域读取都标"会丢响应性"。但单测只读不写
      // （mutation 通过 useCosUpload 等被测 composable 完成），且 refs 通常只活
      // 在单个 it() 块内，不会跨测试污染。禁用以避免批量行级 eslint-disable。
      // 替代规则 `vue/no-ref-object-reactivity-loss` 同义，一起关。
      'vue/no-ref-object-destructure': 'off',
      'vue/no-ref-object-reactivity-loss': 'off',
    },
  },

  // 6. 配置文件（vite/vitest/eslint.config.mjs 自身）：node globals + 关 no-console
  {
    files: ['eslint.config.mjs', 'vite.config.ts', 'vitest.config.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // 6.5 2026-09-13 新增：src/utils/pdfjs.ts 是 pdfjs-dist 唯一白名单入口
  //   上面 .vue / .ts 块的 no-restricted-imports 会自伤（自身两条 import 即命中规则），
  //   这里对该文件单独关闭 no-restricted-imports，保留 pdfjs 单点配置语义。
  //   关联 CLAUDE.md #6。
  {
    files: ['src/utils/pdfjs.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // 7. 全局 linterOptions：大厂共识「防患于未然」式禁用必须被检测
  //    注意 flat config 下必须放在 linterOptions，不是 rules
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },

  // 7.5 2026-09-13 PR 集成 commit：关闭 vue/prefer-true-attribute-shorthand
  //   规则对 kebab-case 形式的 Vue 组件 prop（如 el-upload 的 :show-file-list、
  //   el-table 的 :reserve-selection、el-progress 的 :text-inside 等）报"shorthand
  //   建议"——但 vue-tsc 不识别 shorthand 形式的 kebab-case prop，强制改写为
  //   `:foo-bar` 会触发 TS2551 类型错误。alloy 默认开启此规则 + 全项目 25+ 处
  //   kebab-case shorthand 命中，config 层关闭是唯一可行方案。后续若 vue-tsc 修复
  //   shorthand 类型推导，可单独开启回。
  {
    rules: {
      'vue/prefer-true-attribute-shorthand': 'off',
    },
  },

  // 7.6 2026-09-13 PR 集成 commit：关闭 vue/v-on-event-hyphenation
  //   PR-3 把 emit 声明 + emit() 调用统一改为 camelCase（如 emit('resetOrder')），
  //   而 Vue 3 模板里 @reset-order 只监听 emit('reset-order')，不互通
  //   emit('resetOrder')——必须保持 camelCase 形式才能命中。alloy 默认开启此规则
  //   会强制改写为 kebab，事件就会静默断连。全项目 51 处 camelCase 自定义事件
  //   监听命中，config 层关闭是唯一可行方案。
  {
    rules: {
      'vue/v-on-event-hyphenation': 'off',
    },
  },

  // 8. 关掉与 prettier 冲突的规则（必须放最后）
  prettierConfig,
];
