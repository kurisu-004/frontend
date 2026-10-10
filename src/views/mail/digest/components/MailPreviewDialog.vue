<!--
  MailPreviewDialog.vue — 邮件预览弹窗

  2026-10-13 新建。**纯组件，零 store / 零 api 依赖**（结果由壳传进来）。

  为什么用 `<iframe :srcdoc="html">` 而不是 `v-html`：
    - **安全**：`srcdoc` 内容在一个独立文档里跑，`innerHTML` 不会进父文档的 DOM；
      且本仓没配 CSP 的 `script-src`，srcdoc 里的内联脚本不执行、正文里的
      `<script>` / `onerror=` 之类也拿不到父页面的 `document` / `localStorage`。
      预览的 HTML 来自服务端渲染，内容形态也会随列白名单变化，让它有机会带上
      服务端模板里的任意标签 —— 不进父文档是这里最要紧的一条。
    - **还原度**：邮件正文带自己的内联样式与 `<style>`，注入父文档会与本系统的
      Element Plus 全局样式打架（表格 / 按钮样式被覆写）。独立文档里它看到的是
      浏览器默认样式，正是收件人看到的样子。
    - 代价：不能直接从弹窗里选中文字 / 不能与父页共享滚动。预览场景下都可接受。
-->
<template>
  <el-dialog
    :model-value="modelValue"
    title="邮件预览"
    :width="dlg.width"
    :top="dlg.top"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="loading" class="preview-loading">正在按当前配置渲染邮件…</div>
    <template v-else-if="result">
      <div class="preview-meta">
        <div class="preview-subject">
          <span class="preview-label">主题</span>
          <span class="preview-subject-text">{{ result.subject }}</span>
        </div>
        <div class="preview-counts">
          <el-tag type="danger" size="small" effect="plain"
            >逾期 {{ result.overdue_count }} 条</el-tag
          >
          <el-tag type="warning" size="small" effect="plain">
            未来 {{ result.upcoming_count }} 条
          </el-tag>
          <span class="preview-columns">生效列 {{ result.columns.length }} 列</span>
        </div>
      </div>
      <iframe class="preview-frame" :srcdoc="result.html" title="邮件正文预览" />
    </template>
    <el-empty v-else description="尚无预览内容" />
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
// views/mail/digest/components/MailPreviewDialog.vue
//
// 2026-10-13 新建：见文件头。0 业务状态 —— 显隐与结果都是 prop。

import { useDialogSize } from '@/composables/useDialogSize';
import type { MailDigestPreviewData } from '../mailDigestSchema';

// 不接收 `props` 变量：模板里三个 prop 各自按名直接用（`modelValue` / `result` /
// `loading`），本组件的脚本侧不需要整包读 props。
defineProps<{
  modelValue: boolean;
  result: MailDigestPreviewData | null;
  loading?: boolean;
}>();

// emits 用函数类型（同款理由：@typescript-eslint/prefer-function-type）。
const emit = defineEmits<(e: 'update:modelValue', value: boolean) => void>();

// 宽度自适应用百分比（弹窗随视口变窄时邮件表格才不会被切掉列）；iframe 高度固定
// 600px 自给，**不**挂 `.pdf-preview-dialog` —— 那个 class 是 PdfViewer 专用的高度
// 契约（见 CLAUDE.md「PDF 预览」一节），与本弹窗无关。
const dlg = useDialogSize({ desktopWidth: '80%' });
</script>

<style lang="scss" scoped>
.preview-loading {
  padding: 48px 0;
  text-align: center;
  color: var(--text-secondary);
}

.preview-meta {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-color);
}

.preview-subject {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.preview-label {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.preview-subject-text {
  font-size: 15px;
  font-weight: 600;
  word-break: break-all;
}

.preview-counts {
  display: flex;
  align-items: center;
  gap: 8px;
}

.preview-columns {
  font-size: 12px;
  color: var(--text-secondary);
}

/* 邮件正文高度固定 600px：够看完一张汇总表，弹窗整体不超出视口（top 5vh + 600px
   + 头尾仍在 1080p 内）。宽 100% 让它跟着弹窗自适应。 */
.preview-frame {
  width: 100%;
  height: 600px;
  margin-top: 12px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: #fff;
}
</style>
