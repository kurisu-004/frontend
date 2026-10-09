<!--
  PartInfoCard.vue

  零件信息卡（PartDetail 第 1 张卡）：
  - 内联编辑模式（editing 切换描述/输入）
  - 行内编辑 form 由 usePartDetail 持有，本组件 props 传入，submit emit
  - dialog 不存在；唯一 UI 状态 = editing 标志（由 usePartDetail 持有）

  2026-08-25 frontend-overall-refactor：从 PartDetail.vue 抽出。

  2026-09-13 PR-2 响应式正确性：父级 form = reactive<PartEditForm>(...) 注入，
  vue/no-mutating-props 禁止 props.form.x = v。本地用 reactive 副本（深拷贝 +
  watch 同步）+ emit('update:form', v) 双向同步；父级 @update:form 合并即可。

  2026-09-16 t_part 瘦身（PR-2）：has_been_repaired / actual_delivery_date 随后端
  列下线，「返修」标签与「实际送货」编辑控件 / 展示项一并删除。
-->
<template>
  <el-card v-loading="infoLoading" shadow="never" class="info-card">
    <template v-if="part">
      <template v-if="editing">
        <el-descriptions :column="descCol" border>
          <el-descriptions-item label="序列号">
            <span v-if="part.serial_no" class="mono">{{ part.serial_no }}</span>
            <span v-else class="muted">—</span>
          </el-descriptions-item>
          <el-descriptions-item label="图号">
            <el-input v-model="localForm.drawing_no" size="small" />
          </el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="statusTagType(part.status)" effect="plain" size="small">
              {{ statusLabel(part.status) }}
            </el-tag>
          </el-descriptions-item>

          <el-descriptions-item label="名称" :span="3">
            <el-input v-model="localForm.name" size="small" />
          </el-descriptions-item>

          <el-descriptions-item label="数量">
            <el-input-number
              v-model="localForm.quantity"
              :min="1"
              size="small"
              style="width: 100%"
            />
          </el-descriptions-item>
          <el-descriptions-item label="加急">
            <el-switch v-model="localForm.is_urgent" active-text="加急" />
          </el-descriptions-item>
          <el-descriptions-item label="客户">
            <span v-if="customerDisplay">{{ customerDisplay }}</span>
            <span v-else class="muted">—</span>
          </el-descriptions-item>

          <el-descriptions-item label="计划交期">
            <el-date-picker
              v-model="localForm.planned_delivery_date"
              type="date"
              value-format="YYYY-MM-DD"
              size="small"
              style="width: 100%"
            />
          </el-descriptions-item>
          <!-- 2026-09-16 PR-2：actual_delivery_date 随 t_part 瘦身下线，编辑控件删除 -->
          <el-descriptions-item label="单据 ID">#{{ part.id }}</el-descriptions-item>

          <!-- 送货单字段（PR-F 2026-07-17） -->
          <el-descriptions-item label="订单号">
            <el-input v-model="localForm.order_no" size="small" placeholder="如 6200037950" />
          </el-descriptions-item>
          <el-descriptions-item label="系统交期">
            <el-date-picker
              v-model="localForm.system_delivery_date"
              type="date"
              value-format="YYYY-MM-DD"
              size="small"
              style="width: 100%"
            />
          </el-descriptions-item>
          <el-descriptions-item label="备注">
            <el-input v-model="localForm.note" size="small" placeholder="文员手填" />
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
            <!-- 2026-09-16 PR-2：has_been_repaired 随 t_part 瘦身下线，「返修」标签删除 -->
          </el-descriptions-item>

          <el-descriptions-item label="名称" :span="3">{{ part.name }}</el-descriptions-item>

          <el-descriptions-item label="数量">{{ part.quantity }}</el-descriptions-item>
          <el-descriptions-item label="加急">
            <el-tag v-if="part.is_urgent" type="danger" effect="dark" size="small">加急</el-tag>
            <span v-else class="muted">否</span>
          </el-descriptions-item>
          <el-descriptions-item label="客户">
            <span v-if="customerDisplay">{{ customerDisplay }}</span>
            <span v-else class="muted">—</span>
          </el-descriptions-item>

          <el-descriptions-item label="计划交期">{{
            part.planned_delivery_date
          }}</el-descriptions-item>
          <!-- 2026-09-16 PR-2：actual_delivery_date 随 t_part 瘦身下线，展示项删除 -->
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
import { computed, reactive, watch, toRaw } from 'vue';
import type { PartDetailDto } from '@/api/parts';
import type { OrderStatus } from '@/types/parts';
import type { PartEditForm } from '../composables/usePartDetail';

const props = defineProps<{
  part: PartDetailDto | null;
  editing: boolean;
  saving: boolean;
  form: PartEditForm;
  infoLoading: boolean;
  canEditPart: boolean;
  statusLabel: (s: OrderStatus) => string;
  statusTagType: (s: OrderStatus) => 'primary' | 'success' | 'warning' | 'info' | 'danger';
}>();

const emit = defineEmits<{
  edit: [];
  save: [];
  cancel: [];
  // PR-2 2026-09-13：本地副本变更后通知父级合并回 form。
  'update:form': [v: PartEditForm];
}>();

// PR-2 2026-09-13：父级 form = reactive<PartEditForm>(...)。vue/no-mutating-props
// 禁止 props.form.x = v。深拷贝一份到本地 reactive，模板 v-model 全部绑本地副本；
// 父级 props.form 变更（如 onStartEdit 重置）通过 watch 重新覆盖本地；本地副本
// 变更 emit('update:form') 让父级 Object.assign 合并回去。
//
// 用 watch immediate: true 触发一次性拷贝，避免在 setup 顶层直接读 props.form
// （vue/no-setup-props-destructure）。
// 走 as unknown as 两次断言绕开 TS "object literal" 报错（consistent-type-assertions 不触发，因为是 unknown 中转）
const localForm = reactive({} as unknown as PartEditForm);
watch(
  () => props.form,
  (v) => {
    Object.assign(localForm, structuredClone(toRaw(v)));
  },
  { deep: true, immediate: true },
);
watch(
  localForm,
  (v) => {
    emit('update:form', { ...v });
  },
  { deep: true },
);

const descCol = 3;

/**
 * 「客户」行的展示文案：`一级 / 二级` 两级名（2026-10-10 新增）。
 *
 * 2026-10-10 订正：本行原先读 `part.customer_path`，而后端 `PartDetailOut` **从不返**
 * `customer_path`（那是前端早期臆想的字段）⇒ `customer_path` 恒 undefined ⇒
 * 「一级客户名」从来没在详情页显示过。现在改读后端真的注入的两个字段
 * `l1_customer_name` / `customer_name`。
 *
 * 三种形态：
 *   - 两级都有且不等 → `一级 / 二级`（客户自身是 L1 时后端返相等的两个值，落到第 2 支）；
 *   - 只有一级（间接挂在别人下面的挂靠工单）→ 只显示一级；
 *   - 都没有 → null，模板落「—」。
 */
const customerDisplay = computed<string>(() => {
  const p = props.part;
  if (!p) return '';
  const l1 = p.l1_customer_name?.trim() ?? '';
  const l2 = p.customer_name?.trim() ?? '';
  if (l1 && l2) return l1 === l2 ? l1 : `${l1} / ${l2}`;
  return l1 || l2;
});
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
