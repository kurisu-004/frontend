// 打印模板存储 composable（2026-09-14 重写）。
//
// 背景：本仓库原 usePrintTemplates 是配合旧自研三栏编辑器（PrintTemplateEditor.vue）
// 的 storage 层；随同那版实现已 git rm（见 786eddf / 62db727）。本文件换名为
// useAmdPrintTemplates（Amd = @amdosion/vue3-print），专门服务于新包版编辑器
// PrintTemplateDesigner.vue。
//
// 模式：模块级单例（与 useAuthSession / useScanSession / useBarcodeScanner 同款）。
//
// 本期实现：
//   - localStorage 持久化（key = `amd_print_templates_v1`）
//   - 列表 reactive state（多页共享 + 跨路由保留）
//   - list / get / upsert / remove / setActive / createBlank / rename
//
// 与旧版的差异：模板内容是包版的 `TemplateJson`（来自 tpl.getJson()），
// 不是自研的 PrintTemplate；name 单独提出来存顶层字段，避免去解析 JSON 内的标题。
//
// 后续接入后端：
//   - 把 load() 换成 api.get('/print-templates')
//   - 把 persist() 换成 api.put(`/print-templates/${id}`)
//   - 模块级 ref / 函数签名不动，view 无感知。

import { ref } from 'vue';
import type { TemplateJson } from '@amdosion/vue3-print';

export interface AmdPrintTemplate {
  id: string;
  name: string;
  /** 包版 `tpl.getJson()` 返回的 TemplateJson：含 panels / paperType / printElements 等。 */
  json: TemplateJson;
  createdAt: string;
  updatedAt: string;
}

/** 模板存储于 localStorage 的 schema 版本：未来字段不兼容时 bump 版本号做迁移。 */
export const AMD_TEMPLATE_STORAGE_VERSION = 1;
export const AMD_TEMPLATE_STORAGE_KEY = `amd_print_templates_v${AMD_TEMPLATE_STORAGE_VERSION}`;

interface AmdTemplateStorageEnvelope {
  version: number;
  templates: AmdPrintTemplate[];
}

const templates = ref<AmdPrintTemplate[]>([]);
/** 当前选中的模板 id（null = 未选）。 */
const activeId = ref<string | null>(null);
/** 首屏 storage 读取完成的标记。 */
const ready = ref(false);

function loadFromStorage(): AmdPrintTemplate[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(AMD_TEMPLATE_STORAGE_KEY);
    if (!raw) return [];
    const envelope = JSON.parse(raw) as AmdTemplateStorageEnvelope;
    if (envelope.version !== AMD_TEMPLATE_STORAGE_VERSION) {
      // 版本不匹配：保守起见清空，避免新代码读到旧结构炸字段。
      console.warn(
        `[amd-print-template] storage version ${envelope.version} !== ${AMD_TEMPLATE_STORAGE_VERSION}, reset`,
      );
      localStorage.removeItem(AMD_TEMPLATE_STORAGE_KEY);
      return [];
    }
    return Array.isArray(envelope.templates) ? envelope.templates : [];
  } catch (e) {
    console.warn('[amd-print-template] storage parse failed', e);
    return [];
  }
}

function writeToStorage(list: AmdPrintTemplate[]): void {
  if (typeof localStorage === 'undefined') return;
  const envelope: AmdTemplateStorageEnvelope = {
    version: AMD_TEMPLATE_STORAGE_VERSION,
    templates: list,
  };
  try {
    localStorage.setItem(AMD_TEMPLATE_STORAGE_KEY, JSON.stringify(envelope));
  } catch (e) {
    console.warn('[amd-print-template] storage write failed', e);
  }
}

/** 模块级 init guard：首次 import 触发 load。 */
let inited = false;
function ensureInit(): void {
  if (inited) return;
  inited = true;
  templates.value = loadFromStorage();
  ready.value = true;
}
ensureInit();

/** 生成稳定 id：时间戳 + 随机串，避免碰撞足够。 */
function genId(): string {
  return `tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 创建一份空白模板（A4 单页，无元素），用于「新建」入口。 */
export function createBlankTemplate(name = '新模板'): AmdPrintTemplate {
  const now = new Date().toISOString();
  return {
    id: genId(),
    name,
    json: {
      panels: [{ paperType: 'A4', width: 210, height: 297, printElements: [] }],
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function useAmdPrintTemplates() {
  ensureInit();

  function list(): AmdPrintTemplate[] {
    return templates.value;
  }

  function getById(id: string | null): AmdPrintTemplate | null {
    if (!id) return null;
    return templates.value.find((t) => t.id === id) ?? null;
  }

  function upsert(next: AmdPrintTemplate): void {
    next.updatedAt = new Date().toISOString();
    const idx = templates.value.findIndex((t) => t.id === next.id);
    if (idx >= 0) {
      templates.value.splice(idx, 1, next);
    } else {
      templates.value.push(next);
    }
    writeToStorage(templates.value);
  }

  function remove(id: string): void {
    templates.value = templates.value.filter((t) => t.id !== id);
    writeToStorage(templates.value);
    if (activeId.value === id) activeId.value = null;
  }

  function setActive(id: string | null): void {
    activeId.value = id;
  }

  function rename(id: string, newName: string): void {
    const t = getById(id);
    if (!t) return;
    t.name = newName;
    t.updatedAt = new Date().toISOString();
    upsert(t);
  }

  /** 全量重置：测试 / 调试用。生产不暴露入口。 */
  function _reset(): void {
    templates.value = [];
    activeId.value = null;
    writeToStorage([]);
  }

  return {
    templates,
    activeId,
    ready,
    list,
    getById,
    upsert,
    remove,
    setActive,
    rename,
    createBlankTemplate,
    _reset,
  };
}
