<script setup lang="ts">
// DeliveryGroupEditor — 新建 / 编辑分组弹窗（el-dialog + el-form）。
//
// props:
//   - l1Id: 当前选中的一级客户 id（用于编辑器标题 + 提交时的 customer_id）
//   - initial: 编辑模式下回填的分组；null/undefined 表示新建
//   - allL2Customers: 当前 L1 下的全部 L2 客户（用于成员多选）
//
// emits:
//   - submit(payload): 用户点确认后触发；payload =
//     { name: string, member_customer_ids: string[] }
//   - cancel(): 用户点取消 / 点 × / 点遮罩时触发
//
// 父组件负责调 createDeliveryGroup / updateDeliveryGroup 并处理 ApiError。

import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormRules } from 'element-plus'
import type { Customer } from '@/api/customer'
import type { DeliveryGroupOut } from '@/types/deliveryGroup'

const props = defineProps<{
  l1Id: string
  initial: DeliveryGroupOut | null
  allL2Customers: Customer[]
}>()

const emit = defineEmits<{
  (e: 'submit', payload: { name: string; member_customer_ids: string[] }): void
  (e: 'cancel'): void
}>()

const formRef = ref()
const form = ref({
  name: '',
  member_customer_ids: [] as string[],
})
const submitting = ref(false)

const isEdit = computed(() => !!props.initial)
const dialogTitle = computed(() =>
  isEdit.value ? '编辑分组' : '新增分组',
)

/** 校验规则：name 必填且限制长度；成员列表非必填（可空分组） */
const rules: FormRules = {
  name: [
    { required: true, message: '请输入分组名称', trigger: 'blur' },
    { min: 1, max: 50, message: '1-50 字', trigger: 'blur' },
  ],
}

/** initial 变化 → 回填表单（编辑模式） */
watch(
  () => props.initial,
  (g) => {
    if (g) {
      form.value.name = g.name
      form.value.member_customer_ids = g.members.map((m) => m.customer_id)
    } else {
      form.value.name = ''
      form.value.member_customer_ids = []
    }
  },
  { immediate: true },
)

async function onConfirm(): Promise<void> {
  if (!formRef.value) return
  try {
    await formRef.value.validate()
  } catch {
    return
  }
  submitting.value = true
  try {
    emit('submit', {
      name: form.value.name.trim(),
      member_customer_ids: [...form.value.member_customer_ids],
    })
  } catch (e) {
    ElMessage.error((e as Error).message ?? '提交失败')
  } finally {
    submitting.value = false
  }
}

function onCancel(): void {
  emit('cancel')
}

/** 关闭后清掉校验残留，避免下次打开时还显示错误 */
function onClosed(): void {
  formRef.value?.clearValidate()
}
</script>

<template>
  <el-dialog
    :model-value="true"
    :title="dialogTitle"
    width="520"
    :close-on-click-modal="false"
    :show-close="!submitting"
    append-to-body
    @close="onCancel"
    @closed="onClosed"
  >
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="84px"
      label-position="right"
    >
      <el-form-item label="分组名称" prop="name">
        <el-input
          v-model="form.name"
          placeholder="例如：二五六厂装配件组"
          maxlength="50"
          show-word-limit
        />
      </el-form-item>
      <el-form-item label="L2 成员" prop="member_customer_ids">
        <el-select
          v-model="form.member_customer_ids"
          multiple
          filterable
          placeholder="选择该一级客户下的 L2 客户（可空）"
          style="width: 100%"
        >
          <el-option
            v-for="c in allL2Customers"
            :key="c.id"
            :label="c.name"
            :value="c.id"
          />
        </el-select>
        <p class="form-hint">
          扫码时如果工件的 L2 客户命中这里任一成员，将按 GROUP 路由到本分组对应草稿。
        </p>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button :disabled="submitting" @click="onCancel">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="onConfirm">
        确认
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.form-hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.4;
}
</style>