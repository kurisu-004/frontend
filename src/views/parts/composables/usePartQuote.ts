// views/parts/composables/usePartQuote.ts
//
// 2026-08-25 frontend-overall-refactor：PartDetail 拆分的 usePartQuote。
// 负责零件外协报价列表的拉取 + 新建报价的提交。
//
// 业务数据由 composable 持有；新建报价对话框的 UI 状态（可见性、loading）
// 由 PartQuoteCard 局部维护，提交时调本 composable 的 onCreateQuote。

import { computed, reactive, ref, watch, type Ref } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import {
  createOutsourceQuote,
  listOutsourceCompanies,
  listOutsourceQuotes,
} from '@/api/outsource'
import type { OutsourceQuote } from '@/types/outsource'
import { listProcesses } from '@/api/process'
import type { Process } from '@/types/process'
import { usePermissions } from '@/composables/usePermissions'

/** 新建报价对话框的 form 数据。 */
export interface QuoteCreateForm {
  outsource_company_id: string
  process_id: string
  price: string
  note: string
}

export function usePartQuote(partId: Ref<string>, partName: Ref<string | null | undefined>) {
  const { isManager, isClerk } = usePermissions()

  const quotes = ref<OutsourceQuote[]>([])
  const quotesLoading = ref(false)
  /** MANAGER + CLERK 可见报价卡（PR-H 2026-07-16） */
  const canViewQuotes = computed(() => isManager.value || isClerk.value)
  /** 状态门控：零件状态 ∈ {PENDING, IN_PROCESS, OUTSOURCE, READY_TO_SHIP, REPAIRING} */
  const canCreateQuote = computed(() => {
    // 实际 part 状态门控由 PartQuoteCard 通过 part prop 控制；
    // 这里只暴露角色门控
    return isManager.value || isClerk.value
  })

  async function fetchQuotes(): Promise<void> {
    if (!canViewQuotes.value) {
      quotes.value = []
      quotesLoading.value = false
      return
    }
    quotesLoading.value = true
    try {
      const r = await listOutsourceQuotes({ part_id: partId.value, limit: 200 })
      quotes.value = r.items
    } catch (e) {
      quotes.value = []
      ElMessage.error((e as Error).message ?? '加载外协报价失败')
    } finally {
      quotesLoading.value = false
    }
  }

  // ===== 新建报价：composable 只暴露 form 模板 + 校验规则 + 提交 =====
  // dialog 可见性 / loading / companies 候选 / outsource processes 候选
  // 由 PartQuoteCard 自己持有；这里只放「提交一次」的纯函数。
  function buildQuoteForm(): QuoteCreateForm {
    return {
      outsource_company_id: '',
      process_id: '',
      price: '',
      note: '',
    }
  }

  /** 价格 >0 校验（Element Plus validator 不能直接用 number 转 string 比较） */
  const quoteRules: FormRules = {
    outsource_company_id: [
      { required: true, message: '请选择外协公司', trigger: 'change' },
    ],
    process_id: [
      { required: true, message: '请选择工序', trigger: 'change' },
    ],
    price: [
      { required: true, message: '请填写单价', trigger: 'blur' },
      {
        validator: (_rule, value: string, cb) => {
          const n = Number(value)
          if (value === '' || value == null || Number.isNaN(n) || n <= 0) {
            cb(new Error('单价必须大于 0'))
          } else {
            cb()
          }
        },
        trigger: 'blur',
      },
    ],
  }

  /** 加载新建对话框所需的下拉数据：外协公司 + OUTSOURCE 工序 */
  async function loadQuoteCreateData(): Promise<{
    companies: { id: string; name: string }[]
    outsourceProcesses: Process[]
  }> {
    const [companyResp, procResp] = await Promise.all([
      listOutsourceCompanies({ limit: 200 }),
      listProcesses({ limit: 200 }),
    ])
    return {
      companies: companyResp.items.map((c) => ({ id: c.id, name: c.name })),
      outsourceProcesses: procResp.items.filter((p) => p.category === 'OUTSOURCE'),
    }
  }

  /**
   * 提交新建报价。由 PartQuoteCard 在自家 dialog 内调用：
   *   const ok = await formRef.value.validate()
   *   if (!ok) return
   *   if (await onCreateQuote(quoteForm)) showCreate = false
   */
  async function onCreateQuote(form: QuoteCreateForm): Promise<boolean> {
    try {
      await createOutsourceQuote({
        part_id: partId.value,
        outsource_company_id: form.outsource_company_id,
        process_id: form.process_id,
        price: form.price || '0',
        note: form.note || null,
      })
      ElMessage.success('已创建 DRAFT 报价')
      await fetchQuotes()
      return true
    } catch (e) {
      ElMessage.error((e as Error).message ?? '创建失败')
      return false
    }
  }

  watch(partId, () => {
    quotes.value = []
  })

  return {
    quotes,
    quotesLoading,
    canViewQuotes,
    canCreateQuote,
    fetchQuotes,
    buildQuoteForm,
    quoteRules,
    loadQuoteCreateData,
    onCreateQuote,
  }
}
