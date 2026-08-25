<!--
  PartDeliveryNoteLinkCard.vue

  所属送货单卡（PartDetail 第 3 张卡）：
  - 仅当 part.delivery_note_id 非空时由 shell 渲染
  - 纯展示 + 跳转链接，无 dialog
-->
<template>
  <el-card shadow="never" class="delivery-note-card">
    <template #header>
      <div class="card-header">
        <span class="card-title">
          <el-icon><Document /></el-icon>
          <span>所属送货单</span>
          <el-tag
            v-if="part.delivery_note_status"
            :type="tagType"
            size="small"
            effect="plain"
          >
            {{ statusLabel }}
          </el-tag>
        </span>
        <el-button
          link
          type="primary"
          size="small"
          @click="goToDeliveryNote"
        >
          查看送货单详情
          <el-icon><ArrowRight /></el-icon>
        </el-button>
      </div>
    </template>
    <el-descriptions :column="2" border>
      <el-descriptions-item label="单号">
        {{ part.delivery_note_no ?? '—' }}
      </el-descriptions-item>
      <el-descriptions-item label="状态">
        {{ part.delivery_note_status ?? '—' }}
      </el-descriptions-item>
    </el-descriptions>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowRight, Document } from '@element-plus/icons-vue'
import type { PartItem } from '@/api/parts'
import {
  DELIVERY_NOTE_STATUS_LABEL,
  DELIVERY_NOTE_STATUS_TAG,
  type DeliveryNoteStatus,
} from '@/types/deliveryNote'

const props = defineProps<{
  part: PartItem
}>()

const router = useRouter()

const tagType = computed<'info' | 'success' | 'warning' | 'danger'>(() => {
  const s = props.part.delivery_note_status as DeliveryNoteStatus | null | undefined
  if (!s) return 'info'
  return (DELIVERY_NOTE_STATUS_TAG[s] ?? 'info') as 'info' | 'success' | 'warning' | 'danger'
})

const statusLabel = computed(() => {
  const s = props.part.delivery_note_status as DeliveryNoteStatus | null | undefined
  if (!s) return ''
  return DELIVERY_NOTE_STATUS_LABEL[s] ?? ''
})

function goToDeliveryNote() {
  if (props.part.delivery_note_id != null) {
    router.push(`/delivery-notes/${props.part.delivery_note_id}`)
  }
}
</script>

<style lang="scss" scoped>
.delivery-note-card {
  :deep(.el-card__body) {
    padding: 16px 20px;
  }
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-title {
  font-weight: 600;
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
</style>
