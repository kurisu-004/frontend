<!--
  MailPreviewDialog.vue — 邮件预览弹窗

  2026-10-13 新建。**纯组件，零 store / 零 api 依赖**（结果由壳传进来）。

  为什么用 `<iframe :srcdoc="html">` 而不是 `v-html`：
    - **安全**：`srcdoc` 内容跑在**独立文档**里，`innerHTML` 不会进父文档的 DOM。
      ⚠️ **但「独立文档」不等于「隔离」**（2026-10-14 review 第 1 轮 M-1 订正）：
      **没有 `sandbox` 时 `about:srcdoc` iframe 继承父页 origin**，正文里的内联脚本 /
      `<img onerror=…>` 会在**登录态、同源**上下文里执行，够得着
      `parent.localStorage`（access + refresh token 都在里面）、`parent.document` 全量 DOM，
      并能以当前身份 `fetch('/api/v2/*')`。
      ⚠️ 而本仓**全仓没有 CSP**（`index.html` / nginx 配置都没有
      `Content-Security-Policy`，`main.ts` 也不发 meta 标签）⇒ 内联脚本本来就会执行，
      「没配 CSP」是**没有防线**、不是防线。要挡它得配 CSP 且 `script-src` 不含
      `unsafe-inline`，本仓没配 ⇒ **隔离完全依赖模板里那个空 `sandbox`**。
      触发面不是假想：邮件正文里的零件号 / 名称 / 客户名与配置里的 `subject_template`
      都是任意用户可录入的自由文本，后端只要有一处漏转义就是一次同源 XSS，
      而受害者必然是能进这页的 MANAGER。
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
      <!-- ⚠️ `sandbox` 是**空的**（最大限制）：不透明 origin + 禁 script / form /
           top-navigation / popups / same-origin，邮件预览这三样一个都不需要。
           ⚠️ **不要**改成 `sandbox="allow-same-origin"` —— 那等于把同源放开、等于没加；
           也**不要**为了「能选中文字」加 `allow-scripts`（正文里本就没有脚本，
           放开它只是多一条注入面）。属性由 `__tests__/MailPreviewDialog.spec.ts` 钉死。 -->
      <iframe class="preview-frame" sandbox="" :srcdoc="result.html" title="邮件正文预览" />
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

/* 邮件正文高度固定 600px：够看完一张汇总表，弹窗整体不超出视口（top 取
   `useDialogSize` 的 15vh —— 1080p 下 ≈162px，+ 600px + 头尾 ≈ 946px < 1080）。
   宽 100% 让它跟着弹窗自适应。 */
.preview-frame {
  width: 100%;
  height: 600px;
  margin-top: 12px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: #fff;
}
</style>
