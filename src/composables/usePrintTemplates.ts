// 打印模板存储 composable（2026-09-14 新增）。
//
// 模式：模块级单例（与 CLAUDE.md #1「不要新建 Pinia store」一致），
// 与 useAuthSession / useScanSession / useBarcodeScanner 同款。
//
// 本期实现：
//   - localStorage 持久化（key = print_templates_v1）
//   - 列表 reactive state（多页共享 + 跨路由保留）
//   - 增 / 删 / 改 / 查 / 创建空模板 / 复制模板
//
// 后续接入后端：
//   - 把 load() 换成 api.get('/print-templates')
//   - 把 persist() 换成 api.put(`/print-templates/${id}`)
//   - 模块级 ref / 函数签名不动，所有 view 无感知。

import { reactive, ref } from 'vue';
import {
  type PrintTemplate,
  TEMPLATE_STORAGE_KEY,
  TEMPLATE_STORAGE_VERSION,
  type TemplateStorageEnvelope,
} from '@/views/print-templates/types';

const templates = ref<PrintTemplate[]>([]);
/** 当前选中的模板 id（null = 未选 / 新建草稿）。 */
const activeId = ref<string | null>(null);
/** 持久化过程中（防抖写 + 首屏读）使用，UI 上不影响编辑。 */
const loading = reactive({ ready: false, saving: false });

function loadFromStorage(): PrintTemplate[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(TEMPLATE_STORAGE_KEY);
    if (!raw) return [];
    const envelope = JSON.parse(raw) as TemplateStorageEnvelope;
    if (envelope.version !== TEMPLATE_STORAGE_VERSION) {
      // 版本不匹配：保守起见清空，避免新代码读到旧结构炸字段。
      console.warn(
        `[print-template] storage version ${envelope.version} !== ${TEMPLATE_STORAGE_VERSION}, reset`,
      );
      localStorage.removeItem(TEMPLATE_STORAGE_KEY);
      return [];
    }
    return Array.isArray(envelope.templates) ? envelope.templates : [];
  } catch (e) {
    console.warn('[print-template] storage parse failed', e);
    return [];
  }
}

function writeToStorage(list: PrintTemplate[]): void {
  if (typeof localStorage === 'undefined') return;
  const envelope: TemplateStorageEnvelope = {
    version: TEMPLATE_STORAGE_VERSION,
    templates: list,
  };
  try {
    localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(envelope));
  } catch (e) {
    console.warn('[print-template] storage write failed', e);
  }
}

/** 模块级 init guard：首次 import 触发 load。 */
let inited = false;
function ensureInit(): void {
  if (inited) return;
  inited = true;
  templates.value = loadFromStorage();
  loading.ready = true;
}
ensureInit();

/** 生成稳定 id：时间戳 + 随机串，避免碰撞足够。 */
function genId(): string {
  return `tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 创建一份空白模板（5 列 5 行的演示态）。 */
export function createBlankTemplate(name = '新模板'): PrintTemplate {
  const now = new Date().toISOString();
  const cols = ['col1', 'col2', 'col3', 'col4', 'col5'].map((k, i) => ({
    key: k,
    label: `列 ${i + 1}`,
    width: '1fr',
  }));
  return {
    id: genId(),
    name,
    paper: 'A4',
    orientation: 'portrait',
    margin: { top: 15, bottom: 15, left: 15, right: 15 },
    columns: cols,
    headerCells: cols.map((_c, i) => `表头 ${i + 1}`),
    rowCells: [cols.map((_c, i) => (i === 0 ? '{{$index}}' : `{{row.col${i + 1}}}`))],
    dataSource: 'mock',
    manualDataJson: JSON.stringify(
      [
        {
          col1: '示例 1-1',
          col2: '示例 1-2',
          col3: '示例 1-3',
          col4: '示例 1-4',
          col5: '示例 1-5',
        },
        {
          col1: '示例 2-1',
          col2: '示例 2-2',
          col3: '示例 2-3',
          col4: '示例 2-4',
          col5: '示例 2-5',
        },
        {
          col1: '示例 3-1',
          col2: '示例 3-2',
          col3: '示例 3-3',
          col4: '示例 3-4',
          col5: '示例 3-5',
        },
      ],
      null,
      2,
    ),
    createdAt: now,
    updatedAt: now,
  };
}

/** 复制模板（id + 时间戳刷新，name 加 "(副本)"）。 */
export function cloneTemplate(src: PrintTemplate): PrintTemplate {
  const now = new Date().toISOString();
  return {
    ...(JSON.parse(JSON.stringify(src)) as PrintTemplate),
    id: genId(),
    name: `${src.name} (副本)`,
    createdAt: now,
    updatedAt: now,
  };
}

export function usePrintTemplates() {
  ensureInit();

  function getById(id: string | null): PrintTemplate | null {
    if (!id) return null;
    return templates.value.find((t) => t.id === id) ?? null;
  }

  function upsert(next: PrintTemplate): void {
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

  /** 全量重置：测试 / 调试用。生产不暴露入口。 */
  function _reset(): void {
    templates.value = [];
    activeId.value = null;
    writeToStorage([]);
  }

  return {
    templates,
    activeId,
    loading,
    getById,
    upsert,
    remove,
    setActive,
    createBlankTemplate,
    cloneTemplate,
    _reset,
  };
}
