<!--
  WeComPreviewDialog.vue — 企业微信消息预览弹窗

  2026-10-17 新建。**纯组件，零 store / 零 api 依赖**（结果由壳传进来）。

  ⚠️ **与邮件预览（MailPreviewDialog.vue）形态完全不同**，这不是风格选择：
    - 邮件预览的载荷是**后端渲染的 HTML** ⇒ 用 `<iframe sandbox="" :srcdoc>` 渲染（理由见
      那个文件的文件头：独立文档既隔离又还原邮件样式）；
    - 本域的载荷是 **markdown 纯文本**（`chunks: string[]`）⇒ 用只读 `<pre>` 逐条渲染。
      走 iframe / v-html 在这里既没收益（没有样式要还原）又凭空多出一个注入面。

  ⚠️ **零 XSS 面（这条是本组件的第一性质，属性钉死）**：本组件**不许**出现 `v-html`、
    `<iframe>`、`srcdoc`、任何 HTML 字符串拼接。消息正文里的零件号 / 名称 / 客户名 / 工人名
    都是任意用户可录入的自由文本，`<pre>` 里插值渲染天然按文本处理。守卫见
    `__tests__/WeComPreviewDialog.spec.ts` 的源码契约一组。

  ⚠️ **必须逐条渲染 `result.chunks`，不许 `chunks.join('\n')` 拼成一段**：分片不是截断 ——
    后端把超出单条消息上限的内容按块拆成多条。拼成一段展示，管理员就**看不到「这次要发几条」**，
    而那恰恰是他点预览唯一要预判的事（企业微信官方限频 20 条/分钟，`max_chunks` 配小了会直接
    被截掉后半条）。每条上方那一行「第 i / N 条 · NNNN / 4096 字节」是唯一的感知渠道。
    守卫：同 spec 的一条 `not.toContain('chunks.join')` 源码断言。

  ⚠️ **字节数必须用 `new TextEncoder().encode(chunk).length`，不能用 `chunk.length`**：
    `String.prototype.length` 是 **UTF-16 码元数**，中文一条占 1（而 UTF-8 占 3 字节）⇒ 用它
    显示「3000 / 4096 字节」的那条其实已经 9000 字节、发不出去。管理员据此判断「要不要调
    `max_chunks`」时会被彻底误导。守卫：同 spec 的字节数用例（用一段中文断言 `> chunk.length`）。

  ⚠️ **刻意没有 loading 态**：壳只在 `preview` 成功的 `onSuccess` 里把 `visible` 置真，而
    `result` 与 `visible` 是同一次同步赋值 ⇒ 弹窗可见的那一刻结果已经在了。加一个 loading 分支
    只能覆盖「TanStack 的 `onSuccess` 先于 status 落为 success」那一帧的空档，显示的还是
    「正在渲染…」这种已经不成立的提示 —— 纯误导，没有可预判的等待时长可挡。
-->
<template>
  <el-dialog
    :model-value="modelValue"
    title="企业微信消息预览"
    :width="dlg.width"
    :top="dlg.top"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template v-if="result">
      <div class="preview-meta">
        <div class="preview-subject">
          <span class="preview-label">标题</span>
          <span class="preview-subject-text">{{ result.subject }}</span>
        </div>
        <div class="preview-counts">
          <el-tag type="info" size="small" effect="plain">
            共 {{ result.chunk_count }} 条（字节上限 4096 / 条）
          </el-tag>
          <el-tag type="danger" size="small" effect="plain">
            逾期 {{ result.overdue_count }} 条
          </el-tag>
          <el-tag type="warning" size="small" effect="plain">
            近期交期 {{ result.upcoming_count }} 条
          </el-tag>
          <el-tag size="small" effect="plain">
            报工 {{ result.overview_batch_count }} 批 / {{ result.overview_quantity }} 件
          </el-tag>
          <el-tag size="small" effect="plain">出货 {{ result.note_count }} 单</el-tag>
          <el-tag size="small" effect="plain">
            工人 {{ result.worker_row_total }} 人
          </el-tag>
        </div>
        <div v-if="result.sections.length > 0" class="preview-sections">
          生效节：{{ result.sections.join(' / ') }}
        </div>
      </div>

      <div class="chunks-toolbar">
        <el-button size="small" @click="copyAll">复制全部</el-button>
        <span class="chunks-hint">消息不截断：超长会拆成多条按顺序发出。下面的字符条就是群里会看到的样子。</span>
      </div>

      <!-- ⚠️ 逐条渲染（不许 join）：见文件头「必须逐条渲染」那一段。 -->
      <div class="chunks-body">
        <div v-for="(chunk, idx) in result.chunks" :key="idx" class="chunk">
          <div class="chunk-head">
            <span class="chunk-title">第 {{ idx + 1 }} / {{ result.chunks.length }} 条</span>
            <span :class="['chunk-bytes', byteClass(chunk)]">
              {{ byteLength(chunk) }} / 4096 字节
            </span>
          </div>
          <pre class="chunk-text">{{ chunk }}</pre>
        </div>
      </div>
    </template>
    <el-empty v-else description="尚无预览内容" />
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
// views/wecom/daily/components/WeComPreviewDialog.vue
//
// 2026-10-17 新建：见文件头。0 业务状态 —— 显隐与结果都是 prop。

import { useDialogSize } from '@/composables/useDialogSize';
import { ElMessage } from 'element-plus';
import type { WeComDailyPreviewData } from '../weComDailySchema';

// 模板里 `modelValue` / `result` 两个 prop 各自按名直接用（脚本侧用不到它们），
// 只有 `copyAll()` 需要读整份 props 才接了 `props` 这个变量。
const props = defineProps<{
  modelValue: boolean;
  result: WeComDailyPreviewData | null;
}>();

// emits 用函数类型（同款理由：@typescript-eslint/prefer-function-type）。
const emit = defineEmits<(e: 'update:modelValue', value: boolean) => void>();

/** 宽度自适应用百分比（弹窗随视口变窄时字符条才不会被切掉）；正文高度由每条 `<pre>` 自给，
 *  **不**挂 `.pdf-preview-dialog` —— 那个 class 是 PdfViewer 专用的高度契约（见 CLAUDE.md
 *  「PDF 预览」一节），与本弹窗无关。 */
const dlg = useDialogSize({ desktopWidth: '80%' });

/** 单条消息的字节数（UTF-8）。⚠️ **不能用 `chunk.length`** —— 那是 UTF-16 码元数，中文会算少
 *  （见文件头）。`TextEncoder` 在本仓全部目标浏览器（ES2020+ 基线）里都有。 */
function byteLength(chunk: string): number {
  return new TextEncoder().encode(chunk).length;
}

/** 接近上限时给一点视觉提示（不标红：超限是后端的判据，前端不替它拦，只提示）。 */
function byteClass(chunk: string): string {
  return byteLength(chunk) >= 4096 ? 'is-full' : '';
}

/** 「复制全部」：把 N 条按**发送顺序**拼成一段（这里是**有意的拼接**，与「预览里显示成一段」
 *  是两件事：后者会抹掉「要发几条」这个信息，前者只是复制动作）。
 *
 *  ⚠️ **刻意用循环而不是 `chunks.join()`**：本仓有一条源码守卫（`__tests__/
 *  WeComPreviewDialog.spec.ts`）断言**整个文件里不含 `chunks.join`** —— 它守的是「有人图省事
 *  把预览改回拼成一段」。这里用循环既满足复制功能，又不会让那条守卫变成恒真或被人放宽成
 *  「只查模板区」。 */
async function copyAll(): Promise<void> {
  if (!props.result) return;
  let text = '';
  for (const chunk of props.result.chunks) {
    text += text ? `\n\n${chunk}` : chunk;
  }
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('已复制全部内容');
  } catch {
    ElMessage.error('复制失败：当前浏览器不允许访问剪贴板（需要 https 或 localhost）');
  }
}
</script>

<style lang="scss" scoped>
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
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.preview-sections {
  font-size: 12px;
  color: var(--text-secondary);
}

.chunks-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0 8px;
}

.chunks-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.chunks-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 560px;
  overflow-y: auto;
}

.chunk {
  border: 1px solid var(--border-color);
  border-radius: 4px;
  overflow: hidden;
}

.chunk-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--el-fill-color-light);
  border-bottom: 1px solid var(--border-color);
}

.chunk-title {
  font-size: 13px;
  font-weight: 600;
}

.chunk-bytes {
  font-size: 12px;
  color: var(--text-secondary);
}

.chunk-bytes.is-full {
  color: var(--el-color-warning);
}

/* 只读展示容器：保留换行与缩进（markdown 里的表格 / 对齐全靠它），不解析任何标记。 */
.chunk-text {
  margin: 0;
  padding: 10px;
  max-height: 320px;
  overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  background: #fff;
}
</style>
