<script setup lang="ts">
/**
 * 一步式返修下发 dialog（PR-M 2026-08-04 续）
 *
 * 调 POST /prod/batches/{batch_id}/repair-dispatch：把 DELIVERED / INSPECTION /
 * READY_TO_SHIP 的批次原子流转到 ON_SHELF / INSPECTION，并置 t_part_batch.is_repairing
 * 标记列（返修中只由该布尔列表达，不存在 REPAIRING 中间状态）。
 * （2026-10-02 由 POST /parts/{part_id}/repair-dispatch 迁来：返修下发是批次动作。）
 *
 * UI 结构（el-tabs 双子 Tab）：
 * - 「下发到生产架」：先选工序，后选该工序映射的生产区货架
 * - 「送检到品检架」：直接选 INSPECTION 区货架
 *
 * 2026-10-03：本对话框只做**整批**返修下发。后端 `RepairDispatchRequest` 无
 * quantity 字段（serde 未开 deny_unknown_fields，多带数量会被静默忽略）⇒ 操作员
 * 填「3/10」也会整批 10 件下发。返修部分数量须先 `splitBatch`（`@/api/batch`）拆出子批次、
 * 再对子批次下发，故此处不提供数量控件。
 */
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { CircleCheck, Select } from '@element-plus/icons-vue';
import { repairDispatch } from '@/api/parts';
import { listShelves } from '@/api/shelves';
import { listProcesses } from '@/api/process';
import { useShelfProcessFilter } from '@/composables/useShelfProcessFilter';
import type { RepairBatchListItem } from '@/api/parts';
import type { Shelf } from '@/types/shelf';
import type { Process } from '@/types/process';

const props = defineProps<{
  modelValue: boolean;
  /** 目标**批次**行（listRepairBatches / listRepairingBatches 的列表项）。
   *  必须是批次类型而不是 PartItem：`version` 在这里当 t_part_batch.version 发出去
   *  作 repair-dispatch 的 OCC 锚，`batch_id` 是路径参数，两者都是批次语义。 */
  target: RepairBatchListItem | null;
}>();
const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  confirm: [];
}>();

const actionTab = ref<'dispatch' | 'inspect'>('dispatch');
const processId = ref<string>('');
const shelfId = ref<string>('');
const inspShelfId = ref<string>('');
const submittingDispatch = ref(false);
const submittingInspect = ref(false);

const productionShelves = ref<Shelf[]>([]);
const inspectionShelves = ref<Shelf[]>([]);
const processes = ref<Process[]>([]);

const { filteredShelves: filteredProductionShelves, filteredProcesses } = useShelfProcessFilter(
  productionShelves,
  processes,
  computed({
    get: () => shelfId.value || null,
    set: (v) => {
      shelfId.value = v ?? '';
    },
  }),
  computed({
    get: () => processId.value || null,
    set: (v) => {
      processId.value = v ?? '';
    },
  }),
);

watch(
  // batch_id 是批次行的身份（批次列表项无 id 字段）。
  () => [props.modelValue, props.target?.batch_id] as const,
  async ([v]) => {
    if (v) {
      actionTab.value = 'dispatch';
      processId.value = props.target?.next_process_id ?? '';
      shelfId.value = '';
      inspShelfId.value = '';
      await reloadOptions();
    }
  },
  { immediate: true },
);

async function reloadOptions(): Promise<void> {
  const [prod, insp, procs] = await Promise.all([
    listShelves({ zone: 'PRODUCTION', is_active: true, limit: 200 }),
    listShelves({ zone: 'INSPECTION', is_active: true, limit: 200 }),
    listProcesses({ limit: 200 }),
  ]);
  productionShelves.value = prod.items;
  inspectionShelves.value = insp.items;
  processes.value = procs.items;
  // 2026-10-02：不再显式 load() —— 「货架↔工序」映射改由共享 query 自动跟随
  // productionShelves / processes 就绪（两个源非空即开闸，闸门推导见 useShelfProcessFilter）。
}

async function onSubmit(): Promise<void> {
  if (!props.target) return;
  const isInspect = actionTab.value === 'inspect';
  if (isInspect) {
    if (!inspShelfId.value) return;
  } else {
    if (!shelfId.value) return;
  }
  const submitting = isInspect ? submittingInspect : submittingDispatch;
  submitting.value = true;
  try {
    // 2026-10-02：返修下发迁 prod 域并以批次为锚 —— `POST /prod/batches/{batch_id}/repair-dispatch`，
    // `batch_id` 从 body 删除（已是路径参数），`version` 必填（OCC 锚 t_part_batch）。
    // body 只带后端 RepairDispatchRequest 认识的字段：多带 quantity 会被 serde 静默
    // 忽略（结果是整批返修），所以这里一个数量字段都不发。
    if (!props.target.batch_id) {
      // 类型上 batch_id 必填，但返修两个端点的 wire-format 尚未单独验证（见
      // RepairReceive 的 cast 注），保留这层运行期兜底：空 id 打过去必 404。
      ElMessage.error('该行缺少批次信息，无法下发');
      return;
    }
    await repairDispatch(props.target.batch_id, {
      shelf_id: isInspect ? inspShelfId.value : shelfId.value,
      version: props.target.version,
      next_process_id: !isInspect ? processId.value || null : null,
    });
    const label = props.target.serial_no || props.target.drawing_no;
    ElMessage.success(`返修完成 · ${label} 已${isInspect ? '送检' : '下发'}`);
    emit('confirm');
    emit('update:modelValue', false);
  } catch (e) {
    ElMessage.error(`返修下发失败：${(e as Error).message}`);
  } finally {
    submitting.value = false;
  }
}

function onCancel(): void {
  emit('update:modelValue', false);
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="返修下发"
    width="min(95vw, 720px)"
    :close-on-click-modal="false"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div v-if="target" class="summary">
      <div><strong>流水号：</strong>{{ target.serial_no || '—' }}</div>
      <div><strong>批次：</strong>#{{ target.batch_no }}</div>
      <div><strong>图号：</strong>{{ target.drawing_no }}</div>
      <div><strong>名称：</strong>{{ target.name }}</div>
      <div>
        <strong>总数：</strong>{{ target.quantity }}
        <span class="muted">（整批返修，这批全部回返修）</span>
      </div>
      <!-- 2026-09-16 PR-2：has_been_repaired 随 t_part 瘦身下线，「此前已返修」提示删除 -->
    </div>

    <el-tabs v-model="actionTab" style="margin-top: 8px">
      <el-tab-pane label="下发到生产架" name="dispatch">
        <el-form label-width="96px">
          <el-form-item label="下一道工序">
            <el-select
              v-model="processId"
              clearable
              placeholder="选工序后过滤货架"
              style="width: 100%"
            >
              <el-option
                v-for="p in filteredProcesses"
                :key="p.id"
                :value="String(p.id)"
                :label="`${p.code} — ${p.name}`"
              />
              <template #empty>
                <span class="muted">无可用工序</span>
              </template>
            </el-select>
          </el-form-item>
          <el-form-item label="目标生产货架" required>
            <el-select
              v-model="shelfId"
              clearable
              placeholder="先选工序，自动按 shelf↔process 过滤"
              :disabled="!processId"
              style="width: 100%"
            >
              <el-option
                v-for="s in filteredProductionShelves"
                :key="s.id"
                :value="String(s.id)"
                :label="`${s.code} — ${s.name}`"
                :disabled="!s.is_active"
              />
              <template #empty>
                <span class="muted">
                  {{ processId ? '当前工序未映射任何生产货架' : '请先选择工序' }}
                </span>
              </template>
            </el-select>
          </el-form-item>
        </el-form>
        <div class="actions">
          <el-button
            type="primary"
            :loading="submittingDispatch"
            :disabled="!shelfId"
            @click="onSubmit"
          >
            <el-icon><Select /></el-icon>
            <span>完成 · 下发到生产架</span>
          </el-button>
        </div>
      </el-tab-pane>

      <el-tab-pane label="送检到品检架" name="inspect">
        <el-form label-width="96px">
          <el-form-item label="品检货架" required>
            <el-select
              v-model="inspShelfId"
              clearable
              placeholder="选 INSPECTION 区 active 货架"
              style="width: 100%"
            >
              <el-option
                v-for="s in inspectionShelves"
                :key="s.id"
                :value="String(s.id)"
                :label="`${s.code} — ${s.name}`"
                :disabled="!s.is_active"
              />
              <template #empty>
                <span class="muted">无可用品检架</span>
              </template>
            </el-select>
          </el-form-item>
        </el-form>
        <div class="actions">
          <el-button
            type="warning"
            :loading="submittingInspect"
            :disabled="!inspShelfId"
            @click="onSubmit"
          >
            <el-icon><CircleCheck /></el-icon>
            <span>完成 · 送检到该架</span>
          </el-button>
        </div>
      </el-tab-pane>
    </el-tabs>

    <template #footer>
      <el-button @click="onCancel">取消</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.summary > div {
  margin-bottom: 6px;
  font-size: 14px;
}
.summary > div strong {
  display: inline-block;
  min-width: 70px;
  color: #606266;
}
.muted {
  color: #909399;
}
.actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
</style>
