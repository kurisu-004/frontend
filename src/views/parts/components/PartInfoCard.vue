<!--
  PartInfoCard.vue

  零件信息卡（PartDetail 第 1 张卡）：
  - 内联编辑模式（editing 切换描述/输入）
  - 行内编辑 form 由 usePartDetail 持有，本组件 props 传入，submit emit
  - dialog 不存在；唯一 UI 状态 = editing 标志（由 usePartDetail 持有）

  2026-08-25 frontend-overall-refactor：从 PartDetail.vue 抽出。
-->
<template>
  <el-card shadow="never" class="info-card" v-loading="infoLoading">
    <template v-if="part">
      <template v-if="editing">
        <el-descriptions :column="descCol" border>
          <el-descriptions-item label="序列号">
            <span v-if="part.serial_no" class="mono">{{ part.serial_no }}</span>
            <span v-else class="muted">—</span>
          </el-descriptions-item>
          <el-descriptions-item label="图号">
            <el-input v-model="form.drawing_no" size="small" />
          </el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="statusTagType(part.status)" effect="plain" size="small">
              {{ statusLabel(part.status) }}
            </el-tag>
            <el-tag
              v-if="part.has_been_repaired"
              type="warning"
              size="small"
              effect="dark"
              style="margin-left: 6px"
            >
              返修
            </el-tag>
          </el-descriptions-item>

          <el-descriptions-item label="名称" :span="3">
            <el-input v-model="form.name" size="small" />
          </el-descriptions-item>

          <el-descriptions-item label="数量">
            <el-input-number v-model="form.quantity" :min="1" size="small" style="width:100%" />
          </el-descriptions-item>
          <el-descriptions-item label="加急">
            <el-switch v-model="form.is_urgent" active-text="加急" />
          </el-descriptions-item>
          <el-descriptions-item label="客户">
            <span v-if="part.customer_path">{{ part.customer_path }}</span>
            <span v-else-if="part.customer_name">{{ part.customer_name }}</span>
            <span v-else class="muted">—</span>
          </el-descriptions-item>

          <el-descriptions-item label="计划交期">
            <el-date-picker
              v-model="form.planned_delivery_date" type="date"
              value-format="YYYY-MM-DD" size="small" style="width:100%"
            />
          </el-descriptions-item>
          <el-descriptions-item label="实际送货">
            <el-date-picker
              v-model="form.actual_delivery_date" type="date"
              value-format="YYYY-MM-DD" size="small" style="width:100%"
            />
          </el-descriptions-item>
          <el-descriptions-item label="单据 ID">#{{ part.id }}</el-descriptions-item>

          <!-- 送货单字段（PR-F 2026-07-17） -->
          <el-descriptions-item label="订单号">
            <el-input v-model="form.order_no" size="small" placeholder="如 6200037950" />
          </el-descriptions-item>
          <el-descriptions-item label="系统交期">
            <el-date-picker
              v-model="form.system_delivery_date" type="date"
              value-format="YYYY-MM-DD" size="small" style="width:100%"
            />
          </el-descriptions-item>
          <el-descriptions-item label="备注">
            <el-input v-model="form.note" size="small" placeholder="文员手填" />
          </el-descriptions-item>
        </el-descriptions>

        <div class="edit-actions">
          <el-button @click="$emit('cancel')">取消</el-button>
          <el-button type="primary" :loading="saving" @click="$emit('save')">保存</el-button>
        </div>
      </template>

      <template v-else>
        <el-descriptions :column="descCol" border>
          <el-descriptions-item label="序列号">
            <span v-if="part.serial_no" class="mono">{{ part.serial_no }}</span>
            <span v-else class="muted">—</span>
          </el-descriptions-item>
          <el-descriptions-item label="图号">{{ part.drawing_no }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="statusTagType(part.status)" effect="plain" size="small">
              {{ statusLabel(part.status) }}
            </el-tag>
            <el-tag
              v-if="part.has_been_repaired"
              type="warning"
              size="small"
              effect="dark"
              style="margin-left: 6px"
            >
              返修
            </el-tag>
          </el-descriptions-item>

          <el-descriptions-item label="名称" :span="3">{{ part.name }}</el-descriptions-item>

          <el-descriptions-item label="数量">{{ part.quantity }}</el-descriptions-item>
          <el-descriptions-item label="加急">
            <el-tag v-if="part.is_urgent" type="danger" effect="dark" size="small">加急</el-tag>
            <span v-else class="muted">否</span>
          </el-descriptions-item>
          <el-descriptions-item label="客户">
            <span v-if="part.customer_path">{{ part.customer_path }}</span>
            <span v-else-if="part.customer_name">{{ part.customer_name }}</span>
            <span v-else class="muted">—</span>
          </el-descriptions-item>

          <el-descriptions-item label="计划交期">{{ part.planned_delivery_date }}</el-descriptions-item>
          <el-descriptions-item label="实际送货">
            <span v-if="part.actual_delivery_date">{{ part.actual_delivery_date }}</span>
            <span v-else class="muted">—</span>
          </el-descriptions-item>
          <el-descriptions-item label="单据 ID">#{{ part.id }}</el-descriptions-item>

          <!-- 送货单字段（PR-F 2026-07-17） -->
          <el-descriptions-item label="订单号">
            <span v-if="part.order_no">{{ part.order_no }}</span>
            <span v-else class="muted">—</span>
          </el-descriptions-item>
          <el-descriptions-item label="系统交期">
            <span v-if="part.system_delivery_date">{{ part.system_delivery_date }}</span>
            <span v-else class="muted">—</span>
          </el-descriptions-item>
          <el-descriptions-item label="备注">
            <span v-if="part.note">{{ part.note }}</span>
            <span v-else class="muted">—</span>
          </el-descriptions-item>
        </el-descriptions>

        <div class="edit-actions">
          <el-button v-if="canEditPart" type="primary" plain @click="$emit('edit')">编辑</el-button>
        </div>
      </template>
    </template>
  </el-card>
</template>

<script setup lang="ts">
import type { PartItem } from '@/api/parts'
import type { OrderStatus } from '@/types/parts'
import type { PartEditForm } from '../composables/usePartDetail'

const props = defineProps<{
  part: PartItem | null
  editing: boolean
  saving: boolean
  form: PartEditForm
  infoLoading: boolean
  canEditPart: boolean
  statusLabel: (s: OrderStatus) => string
  statusTagType: (s: OrderStatus) => 'primary' | 'success' | 'warning' | 'info' | 'danger'
}>()

defineEmits<{
  (e: 'edit'): void
  (e: 'save'): void
  (e: 'cancel'): void
}>()

const descCol = 3
</script>

<style lang="scss" scoped>
.info-card {
  :deep(.el-card__body) {
    padding: 16px 20px;
  }
}

.edit-actions {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.muted {
  color: var(--text-secondary);
}
.mono {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
}
</style>
