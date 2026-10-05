<!--
  PartBatchPdfTab.vue

  Tab 2「PDF 批量上传」内容：
  - L1 客户 + 请购日期 表单
  - PDF / Excel / 3D 模型三个 el-upload
  - 源文件区（PDF 多页树状表格）
  - 独立零件表 / 装配件表
  - 手动新增零件 / 装配件 Dialog
  - PDF 预览 Dialog

  2026-08-25 拆分：原 PartBatchNew.vue 第 367-1064 行整段挪到本组件，state + handler
  在父组件 usePartBatchPdf() 里；本组件 props 全部由父组件 `v-bind` 摊开传入。

  2026-09-13 PR-2：父级 pdfForm / manualPartForm / manualAsmForm 是 reactive，
  本组件改为本地 reactive 副本 + watch 同步 + emit('update:pdf-form' / 'update:manual-part-form' /
  'update:manual-asm-form')；父组件 v-bind 摊开后再单独监听 emit 把值合并回
  usePartBatchPdf 持有的 form。

  2026-10-04：底部提交按钮只有一个（建工单 + 逐 part 后置上传一次完成）。行内「上传」列
  保留，cell 状态由 composable 在建单成功后的后置上传阶段写入；补传在途时行内「重试」
  置灰（由 cellRetryDisabled 驱动）。
-->

<template>
  <p class="hint">
    拖拽多个 PDF 文件（命名格式 <code>图号_零件名称.pdf</code>）， 可同时拖入应标 / 历史价确认单
    Excel 文件（按图号匹配申请人/数量/加急等）。 多页 PDF
    拆为候选页：勾选页可「合并为零件」或「合并为装配件」； 单页 PDF 直接进入独立零件表。可手动新增 /
    删除条目。
  </p>

  <el-card shadow="never" class="pdf-form-card">
    <el-form :model="localPdfForm" inline>
      <el-form-item label="L1 客户" required>
        <el-select
          v-model="localPdfForm.customerL1Id"
          placeholder="选择一级客户"
          filterable
          clearable
          style="width: 240px"
        >
          <el-option v-for="c in l1Customers" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="请购日期">
        <el-date-picker
          v-model="localPdfForm.requestDate"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="默认今天"
          style="width: 160px"
        />
      </el-form-item>
    </el-form>

    <el-row :gutter="16">
      <el-col :span="12">
        <el-upload
          multiple
          accept=".pdf"
          :auto-upload="false"
          :file-list="pdfFiles"
          :on-change="onPdfChange"
          :on-remove="onPdfRemove"
          drag
        >
          <el-icon class="el-icon--upload"><upload-filled /></el-icon>
          <div class="el-upload__text">拖拽或点击上传 PDF（可多个）</div>
          <template #tip>
            <div class="el-upload__tip">多页 PDF 会自动拆为候选页</div>
          </template>
        </el-upload>
      </el-col>
      <el-col :span="12">
        <el-upload
          accept=".xlsx,.xls"
          :auto-upload="false"
          :file-list="excelFiles"
          :on-change="onExcelChange"
          :on-remove="onExcelRemove"
          drag
          :show-file-list="true"
        >
          <el-icon class="el-icon--upload"><document /></el-icon>
          <div class="el-upload__text">拖拽应标 / 历史价确认单 Excel（可选；按图号匹配）</div>
          <template #tip>
            <div class="el-upload__tip">
              支持：① 应标 Excel（列：物料编号 / 货物(劳务)名称 / 申请人 / 数量 / 单价 / 紧急状态 /
              预估交期天数） · ② 历史价确认单（列：申请部门 / 申请人 / 交期(天) / 物料编号 /
              物料名称 / 采购数量 / 含税单价 / 含税价格）
            </div>
          </template>
        </el-upload>
      </el-col>
    </el-row>

    <!-- PR-H 2026-07-28：3D 模型批量上传（与 PDF / Excel 并排；命名约定 图号_名称.step） -->
    <el-row :gutter="16" style="margin-top: 16px">
      <el-col :span="24">
        <el-upload
          multiple
          accept=".step,.stp,.iges,.igs,.stl,.obj,.3mf"
          :auto-upload="false"
          :file-list="threeDModelFiles"
          :on-change="onThreeDModelChange"
          :on-remove="onThreeDModelRemove"
          drag
        >
          <el-icon class="el-icon--upload"><upload-filled /></el-icon>
          <div class="el-upload__text">
            拖拽或点击上传 3D 模型（可选；按文件名图号自动挂到对应零件行）
          </div>
          <template #tip>
            <div class="el-upload__tip">
              支持格式：.step / .stp / .iges / .igs / .stl / .obj / .3mf ·
              文件名约定：<strong>图号_名称.ext</strong>，与下方独立零件 /
              装配件子件的图号一致。提交后入库为 <code>kind=THREE_D_MODEL</code>。
            </div>
          </template>
        </el-upload>
      </el-col>
    </el-row>

    <div class="pdf-actions">
      <el-button
        type="primary"
        :disabled="pdfFiles.length === 0 || pdfBuildingTree || pdfSubmitting"
        @click="rebuildFromUploads"
      >
        <el-icon><magic-stick /></el-icon>
        <span>{{ allPdfs.length > 0 ? '重新解析拆分' : '解析拆分' }}</span>
      </el-button>
      <span class="tree-stat">
        源文件 {{ allPdfs.length }} 个 · 独立零件 {{ standaloneParts.length }} 条 · 装配件
        {{ assemblies.length }} 个（共 {{ totalAssemblyChildren }} 子件）
      </span>
    </div>
  </el-card>

  <!-- ① 源文件区 -->
  <el-card v-if="allPdfs.length > 0" shadow="never" class="pdf-source-card">
    <div class="source-header">
      <span class="title">源文件区</span>
      <span class="hint-inline">
        勾选页后用右侧按钮归组；勾选父级（PDF 文件名） = 全选该 PDF 全部页
      </span>
      <div class="source-actions">
        <el-button
          type="primary"
          plain
          :disabled="selectedPages.size === 0"
          @click="mergeSelectedAsPart"
        >
          <el-icon><link /></el-icon>
          <span>合并为零件</span>
        </el-button>
        <el-button
          type="warning"
          plain
          :disabled="selectedPages.size < 2"
          @click="mergeSelectedAsAssembly"
        >
          <el-icon><files /></el-icon>
          <span>合并为装配件</span>
        </el-button>
        <el-button @click="handleClearSelection">清空选择</el-button>
      </div>
    </div>

    <!-- 2026-08-27 T23：列设置工具条（与 ListShell / PartBatchMonitorCard 同款） -->
    <div class="table-toolbar">
      <ColumnVisibilityPopover
        :defs="columnDefs_source"
        :model-value="columnVisibility_source.currentMap"
        @update:model-value="columnVisibility_source.update"
        @reset="columnVisibility_source.showAll"
        @resetOrder="drag_source.reset"
      />
    </div>

    <!-- 2026-08-22 a11y：selection 列所在 table 加 aria-label -->
    <el-table
      ref="sourceTableRefLocal"
      :data="sourceTree"
      row-key="id"
      :tree-props="{ children: 'children' }"
      default-expand-all
      border
      aria-label="PDF 源文件列表"
      class="pdf-source-table"
      @selection-change="onSourceSelectionChange"
    >
      <el-table-column type="selection" width="55" />
      <template v-for="d in drag_source.orderedDefs.value" :key="columnIdentifier(d)">
        <el-table-column
          v-if="columnVisibility_source.isVisible(d.key)"
          :prop="d.prop ?? d.key"
          :label="d.label"
          :width="d.width"
          :min-width="d.minWidth"
          :align="d.align"
          :show-overflow-tooltip="d.showOverflowTooltip"
          :label-class-name="drag_source.dragLabelClass(d)"
          :column-key="d.columnKey ?? d.key"
        >
          <template v-if="d.cellRender" #default="scope">
            <component :is="d.cellRender(scope)" />
          </template>
          <template v-if="resolveDraggable(d) && !d.type && !d.fixed" #header>
            <span>{{ d.label }}</span>
            <ColumnDragHandle :title="`拖动 ${d.label} 列`" />
          </template>
        </el-table-column>
      </template>
      <el-table-column label="操作" min-width="100" align="center">
        <template #default="{ row }">
          <el-button
            v-if="(row as SourceTreeRow).pageIndex === null"
            link
            type="danger"
            @click="removePdf((row as SourceTreeRow).pdfSourceUid)"
            >删除</el-button
          >
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <!-- ② 独立零件表 + ③ 装配件表（上下堆叠） -->
  <div v-if="allPdfs.length > 0">
    <el-card shadow="never" class="pdf-standalone-card">
      <div class="table-header">
        <span class="title">独立零件（{{ standaloneParts.length }}）</span>
        <el-button type="primary" plain size="small" @click="addManualPart">
          <el-icon><plus /></el-icon>
          <span>新增零件</span>
        </el-button>
      </div>
      <!-- 2026-08-27 T23：列设置工具条（与 ListShell / PartBatchMonitorCard 同款） -->
      <div class="table-toolbar">
        <ColumnVisibilityPopover
          :defs="columnDefs_standalone"
          :model-value="columnVisibility_standalone.currentMap"
          @update:model-value="columnVisibility_standalone.update"
          @reset="columnVisibility_standalone.showAll"
          @resetOrder="drag_standalone.reset"
        />
      </div>
      <el-table
        :ref="bindStandaloneTableRef"
        :data="standaloneParts"
        row-key="uid"
        border
        size="small"
        empty-text="还没有独立零件。可在「源文件区」勾选页后合并，或直接新增。"
        class="pdf-standalone-table"
      >
        <!-- 行拖拽手柄：width=36 列不进 defs（始终首位 + 不可拖） -->
        <el-table-column width="36" align="center" label="">
          <template #default>
            <el-icon class="drag-handle" title="拖动排序"><Rank /></el-icon>
          </template>
        </el-table-column>
        <!-- 2026-08-27 T23：列顺序拖动接入；orderedDefs 提供持久化顺序。 -->
        <template v-for="d in drag_standalone.orderedDefs.value" :key="columnIdentifier(d)">
          <el-table-column
            v-if="columnVisibility_standalone.isVisible(d.key)"
            :prop="d.prop ?? d.key"
            :label="d.label"
            :width="d.width"
            :min-width="d.minWidth"
            :align="d.align"
            :show-overflow-tooltip="d.showOverflowTooltip"
            :label-class-name="drag_standalone.dragLabelClass(d)"
            :column-key="d.columnKey ?? d.key"
          >
            <template v-if="d.cellRender" #default="scope">
              <component :is="d.cellRender(scope)" />
            </template>
            <template v-if="resolveDraggable(d) && !d.type && !d.fixed" #header>
              <span>{{ d.label }}</span>
              <ColumnDragHandle :title="`拖动 ${d.label} 列`" />
            </template>
          </el-table-column>
        </template>
        <!-- 2026-09-16 T3.4：上传状态列（PDF + 3D 模型进度 / 重试）。cells 仅在提交
             流程启动后被填充，submit 前为空。 -->
        <el-table-column label="上传" min-width="140" align="center">
          <template #default="{ row }">
            <div class="upload-cell">
              <UploadStatusCellView
                :cell="getRowPdfCell(row as StandalonePartRow)"
                label="PDF"
                :retry-disabled="cellRetryDisabled"
                @retry="onRetryRowPdf(row as StandalonePartRow)"
              />
              <UploadStatusCellView
                v-if="(row as StandalonePartRow).three_d_index !== null"
                :cell="getRowThreeDCell(row as StandalonePartRow)"
                label="3D"
                :retry-disabled="cellRetryDisabled"
                @retry="onRetryRowThreeD(row as StandalonePartRow)"
              />
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="120" align="center" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.mergedFrom && row.mergedFrom.length > 1"
              link
              type="warning"
              size="small"
              @click="splitStandalonePart(row as StandalonePartRow)"
              >拆分</el-button
            >
            <el-button link type="danger" size="small" @click="removeStandalonePart(row.uid)"
              >删除</el-button
            >
          </template>
        </el-table-column>
      </el-table>
    </el-card>
    <el-card shadow="never" class="pdf-assembly-card">
      <div class="table-header">
        <span class="title">装配件（{{ assemblies.length }}）</span>
        <el-button type="primary" plain size="small" @click="addManualAssembly">
          <el-icon><plus /></el-icon>
          <span>新增装配件</span>
        </el-button>
      </div>
      <!-- 2026-08-27 T23：列设置工具条（与 ListShell / PartBatchMonitorCard 同款） -->
      <div class="table-toolbar">
        <ColumnVisibilityPopover
          :defs="columnDefs_assembly"
          :model-value="columnVisibility_assembly.currentMap"
          @update:model-value="columnVisibility_assembly.update"
          @reset="columnVisibility_assembly.showAll"
          @resetOrder="drag_assembly.reset"
        />
      </div>
      <el-table
        :ref="bindAssembliesTableRef"
        :data="assemblies"
        row-key="uid"
        border
        size="small"
        empty-text="还没有装配件。可在「源文件区」勾选多页后合并，或直接新增。"
        class="pdf-assembly-table"
      >
        <!-- 行拖拽手柄：width=36 列不进 defs（始终首位 + 不可拖） -->
        <el-table-column width="36" align="center" label="">
          <template #default>
            <el-icon class="drag-handle" title="拖动排序"><Rank /></el-icon>
          </template>
        </el-table-column>
        <!-- expand 列不进 defs（EP type='expand' 不可拖；子件表固定结构） -->
        <el-table-column type="expand">
          <template #default="{ row }">
            <!-- 2026-10-05：被指定为总装图的那一页整行置灰 + 打「总装图」标签 ——
                 它不再作为子件建出（页不能既当总装图又当子件），但行内容不删不改，
                 切回「无」时用户填的图号 / 交期仍在。 -->
            <el-table
              :data="(row as AssemblyRow).children"
              size="small"
              :show-header="true"
              :row-class-name="childRowClass(row as AssemblyRow)"
              class="child-table"
            >
              <el-table-column label="页" min-width="110" align="center">
                <template #default="{ row: c }">
                  <span>P{{ c.page_index + 1 }}</span>
                  <el-tag
                    v-if="c.page_index === (row as AssemblyRow).masterPageIndex"
                    type="info"
                    size="small"
                    effect="plain"
                    >总装图</el-tag
                  >
                </template>
              </el-table-column>
              <el-table-column label="图号" min-width="140" align="center">
                <template #default="{ row: c }">
                  <el-input v-model="c.drawing_no" size="small" />
                </template>
              </el-table-column>
              <el-table-column label="名称" min-width="140" align="center">
                <template #default="{ row: c }">
                  <el-input v-model="c.name" size="small" />
                </template>
              </el-table-column>
              <el-table-column label="数量" min-width="90" align="center">
                <template #default="{ row: c }">
                  <el-input-number
                    v-model="c.quantity"
                    :min="1"
                    :max="9999"
                    size="small"
                    controls-position="right"
                    style="width: 90px"
                  />
                </template>
              </el-table-column>
              <el-table-column label="含税单价" min-width="110" align="center">
                <template #default="{ row: c }">
                  <el-input-number
                    v-model="c.unit_price"
                    :min="0"
                    :max="MONEY_MAX"
                    :precision="2"
                    :step="1"
                    size="small"
                    controls-position="right"
                    placeholder="可填"
                    style="width: 100px"
                    @change="
                      (v: number | undefined) => onChildUnitPriceChange(c as AssemblyChildRow, v)
                    "
                  />
                </template>
              </el-table-column>
              <el-table-column label="含税价格" min-width="110" align="center">
                <template #default="{ row: c }">
                  <el-input-number
                    v-model="c.total_price"
                    :min="0"
                    :max="MONEY_MAX"
                    :precision="2"
                    :step="1"
                    size="small"
                    controls-position="right"
                    placeholder="可填"
                    style="width: 100px"
                  />
                </template>
              </el-table-column>
              <el-table-column label="3D" min-width="55" align="center">
                <template #default="{ row: c }">
                  <!-- 2026-10-05：这一列表达「3D 文件已挂到本行」。被指定为总装图的那一页
                       不作为子件建出、它的 3D 也不会上传 ⇒ 该行改用中性 tag，别再用绿勾
                       暗示会上传。 -->
                  <el-tag
                    v-if="c.three_d_index !== null"
                    :type="
                      c.page_index === (row as AssemblyRow).masterPageIndex ? 'info' : 'success'
                    "
                    :effect="
                      c.page_index === (row as AssemblyRow).masterPageIndex ? 'plain' : 'light'
                    "
                    size="small"
                    >{{
                      c.page_index === (row as AssemblyRow).masterPageIndex ? '3D 不上传' : '3D ✓'
                    }}</el-tag
                  >
                </template>
              </el-table-column>
              <el-table-column label="计划交期" min-width="150" align="center">
                <template #default="{ row: c }">
                  <el-date-picker
                    v-model="c.planned_delivery_date"
                    type="date"
                    value-format="YYYY-MM-DD"
                    size="small"
                    clearable
                    placeholder="选交期"
                    style="width: 130px"
                  />
                </template>
              </el-table-column>
              <el-table-column label="加急" min-width="70" align="center">
                <template #default="{ row: c }">
                  <el-switch v-model="c.is_urgent" />
                </template>
              </el-table-column>
              <el-table-column label="备注" min-width="120" align="center">
                <template #default="{ row: c }">
                  <el-input
                    v-model="c.note"
                    size="small"
                    type="textarea"
                    :rows="1"
                    placeholder="选填"
                  />
                </template>
              </el-table-column>
              <!-- 2026-10-05：子件上传状态（各自那一页的单页切片 + 各自 3D）。
                   被指定为总装图的那一页不建出子件，它的状态格取的是同一个切片的
                   `asmMaster` entry（这一页确实作为总装图传了）⇒ 标签改成「总装图」，
                   免得在子件表里读成「该页作为子件传了」。状态与重试入口照旧：
                   顶层行本来就渲染同一个 cell（见总装图那列），两处指向同一份状态。 -->
              <el-table-column label="上传" min-width="140" align="center">
                <template #default="{ row: c }">
                  <div class="upload-cell">
                    <UploadStatusCellView
                      :cell="getRowPdfCell(c as AssemblyChildRow)"
                      :label="
                        c.page_index === (row as AssemblyRow).masterPageIndex ? '总装图' : 'PDF'
                      "
                      :retry-disabled="cellRetryDisabled"
                      @retry="onRetryRowPdf(c as AssemblyChildRow)"
                    />
                    <UploadStatusCellView
                      v-if="(c as AssemblyChildRow).three_d_index !== null"
                      :cell="getRowThreeDCell(c as AssemblyChildRow)"
                      label="3D"
                      :retry-disabled="cellRetryDisabled"
                      @retry="onRetryRowThreeD(c as AssemblyChildRow)"
                    />
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </template>
        </el-table-column>
        <!-- 2026-08-27 T23：列顺序拖动接入；orderedDefs 提供持久化顺序。 -->
        <template v-for="d in drag_assembly.orderedDefs.value" :key="columnIdentifier(d)">
          <el-table-column
            v-if="columnVisibility_assembly.isVisible(d.key)"
            :prop="d.prop ?? d.key"
            :label="d.label"
            :width="d.width"
            :min-width="d.minWidth"
            :align="d.align"
            :show-overflow-tooltip="d.showOverflowTooltip"
            :label-class-name="drag_assembly.dragLabelClass(d)"
            :column-key="d.columnKey ?? d.key"
          >
            <template v-if="d.cellRender" #default="scope">
              <component :is="d.cellRender(scope)" />
            </template>
            <template v-if="resolveDraggable(d) && !d.type && !d.fixed" #header>
              <span>{{ d.label }}</span>
              <ColumnDragHandle :title="`拖动 ${d.label} 列`" />
            </template>
          </el-table-column>
        </template>
        <!-- 2026-10-05：顶层「主图」只挂被指定为总装图的那一页的切片；没有总装图时
             不产生 ASSEMBLY_MASTER 上传 job（库里也没那行），如实说明打印侧的后果。 -->
        <el-table-column label="上传" min-width="140" align="center">
          <template #default="{ row }">
            <UploadStatusCellView
              v-if="(row as AssemblyRow).masterPdfSourceUid"
              :cell="getRowPdfCell({ pdfSourceUid: (row as AssemblyRow).masterPdfSourceUid })"
              label="主图"
              :retry-disabled="cellRetryDisabled"
              @retry="onRetryRowPdf({ pdfSourceUid: (row as AssemblyRow).masterPdfSourceUid })"
            />
            <span v-else class="no-master-hint">无总装图（打印时不出总装图与序列号背面）</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="80" align="center" fixed="right">
          <template #default="{ row }">
            <el-button link type="danger" size="small" @click="removeAssembly(row.uid)"
              >删除</el-button
            >
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>

  <!-- 提交按钮：放在装配件表下方（form-card 顶部仅保留解析拆分）。
       2026-10-04：单入口 —— 一次点击完成「建工单 + 逐 part 后置上传图纸/3D」；
       上传失败时工单已建，按钮转「重试上传（N 项）」，绝不重复建单。 -->
  <div v-if="allPdfs.length > 0" class="pdf-footer-actions">
    <el-button
      type="primary"
      size="large"
      :disabled="!canSubmit || pdfSubmitting"
      :loading="pdfSubmitting"
      @click="commitStage === 'done' ? retryFailedUploads() : onSubmit()"
    >
      <el-icon><upload-filled /></el-icon>
      <span>{{ submitLabel }}</span>
    </el-button>
  </div>

  <!-- PDF 文件名点击触发的全屏预览（Tab 2）。blob URL 生命周期见
       openPdfPreview / closePdfPreview。 -->
  <el-dialog
    :model-value="pdfPreviewVisible"
    class="pdf-preview-dialog"
    :title="pdfPreviewing?.title ?? 'PDF 预览'"
    fullscreen
    destroy-on-close
    :before-close="closePdfPreview"
    @update:model-value="(v: boolean) => !v && closePdfPreview()"
  >
    <PdfViewer v-if="pdfPreviewing?.url" :url="pdfPreviewing.url" :page="pdfPreviewing.page" />
  </el-dialog>

  <!-- 手动新增零件 dialog -->
  <el-dialog
    :model-value="manualPartDialogVisible"
    title="新增独立零件"
    width="520px"
    destroy-on-close
    @update:model-value="(v: boolean) => !v && closeManualPartDialog()"
  >
    <el-form :model="localManualPartForm" label-width="80px">
      <el-form-item label="图号" required>
        <el-input v-model="localManualPartForm.drawing_no" placeholder="必填" />
      </el-form-item>
      <el-form-item label="名称">
        <el-input v-model="localManualPartForm.name" placeholder="选填" />
      </el-form-item>
      <el-form-item label="图纸" required>
        <el-upload
          accept=".pdf"
          :auto-upload="false"
          :file-list="manualPartFileList"
          :on-change="onManualPartFileChange"
          :on-remove="onManualPartFileRemove"
          :show-file-list="true"
        >
          <el-button>选择 PDF</el-button>
          <template #tip>
            <div class="el-upload__tip">单文件 · 与源文件区无关</div>
          </template>
        </el-upload>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="closeManualPartDialog">取消</el-button>
      <el-button type="primary" :disabled="!manualPartFormValid" @click="confirmManualPart"
        >添加</el-button
      >
    </template>
  </el-dialog>

  <!-- 手动新增装配件 dialog -->
  <el-dialog
    :model-value="manualAsmDialogVisible"
    title="新增装配件"
    width="520px"
    destroy-on-close
    @update:model-value="(v: boolean) => !v && closeManualAsmDialog()"
  >
    <el-form :model="localManualAsmForm" label-width="80px">
      <el-form-item label="图号" required>
        <el-input v-model="localManualAsmForm.drawing_no" placeholder="必填" />
      </el-form-item>
      <el-form-item label="名称">
        <el-input v-model="localManualAsmForm.name" placeholder="选填" />
      </el-form-item>
      <el-form-item label="图纸" required>
        <el-upload
          accept=".pdf"
          :auto-upload="false"
          :file-list="manualAsmFileList"
          :on-change="onManualAsmFileChange"
          :on-remove="onManualAsmFileRemove"
          :show-file-list="true"
        >
          <el-button>选择 PDF</el-button>
          <template #tip>
            <div class="el-upload__tip">上传后按页数自动生成子件</div>
          </template>
        </el-upload>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="closeManualAsmDialog">取消</el-button>
      <el-button type="primary" :disabled="!manualAsmFormValid" @click="confirmManualAssembly"
        >添加</el-button
      >
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
// 2026-08-28 改造：列顺序拖动 + 可见性（3 个 el-table）。
// 旧版 watcher 派生 headerRowRef_* → onMounted applyDrag 二次绑定的链路拆掉。
// 现在直接传 el-table 实例 ref，composable 内部解析表头 + MutationObserver 自愈
// （覆盖 v-if/destroy 重建 / 表头首次渲染未到两种场景）。

import { h, inject, onMounted, reactive, ref, toRaw, watch, type Ref } from 'vue';
import {
  ElAutocomplete,
  ElDatePicker,
  ElInput,
  ElInputNumber,
  ElLink,
  ElOption,
  ElSelect,
  ElSwitch,
  ElTag,
} from 'element-plus';
import type { UploadFile } from 'element-plus';
// 2026-10-03 补 Element Plus 样式副作用 import（修 el-select 错位 + 点不中）：
// unplugin-vue-components 的 ElementPlusResolver 只负责**模板**里用到的标签；脚本作用域里
// 已经显式绑定了同名组件时它认为「本文件已自行负责」，直接跳过 → 不再注入对应的
// `element-plus/es/components/<name>/style/css` 副作用 import。
// 本文件的 9 个 EP 组件（autocomplete / date-picker / input / input-number / link /
// option / select / switch / tag）都因为要传 `h()` 渲染函数而必须显式 import，于是模板
// 版本也一并拿不到 resolver 的样式注入 —— 整条路由的 EP CSS 只剩同路由别的文件顺带
// 注入那点（属巧合，不是设计；`/parts/new` 是全仓唯一用 el-select 的路由，于是
// el-select / el-option 的 CSS 一个字节都没加载）。
// 漏注入的表现：`.el-select__wrapper` 退回 display:block（正确应为 inline-flex +
// position:relative），placeholder 与 caret 掉到原生 input 下方/第三行、被下一行单元格
// 内容盖住 → 用户看到「标签右边一个空框、选择一级客户掉行」，且点 caret 落不到 popper。
// 各入口的传递闭包按 node_modules 实际内容核对：select 带 option / option-group / tag /
// scrollbar / popper，autocomplete 带 input，date-picker 带 date-picker-panel，
// input-number 带 input —— 上列 9 个组件被全覆盖。
import 'element-plus/es/components/select/style/css';
import 'element-plus/es/components/autocomplete/style/css';
import 'element-plus/es/components/date-picker/style/css';
import 'element-plus/es/components/input-number/style/css';
import 'element-plus/es/components/switch/style/css';
import 'element-plus/es/components/link/style/css';
import { Document, MagicStick, Plus, Rank, UploadFilled, Files } from '@element-plus/icons-vue';
import PdfViewer from '@/components/PdfViewer.vue';
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility';
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import UploadStatusCellView from '@/components/UploadStatusCellView.vue';
import type {
  AssemblyChildRow,
  AssemblyRow,
  PdfPreviewState,
  SourceTreeRow,
  StandalonePartRow,
} from '../composables/usePartBatchPdf';

// 父组件 `v-bind="pdf"` 摊开传入本组件需要的所有 props。
// 2026-08-25 fix：源文件区 el-table ref 改成本组件本地 ref（之前写在父组件的
// readonly prop 上时，clearSelection 静默丢写）。
// 2026-08-27：独立零件 / 装配件 el-table ref 改由父组件 usePartBatchPdf composable
// 持有，通过 provide/inject 拿回，避免 props readonly 丢写 + 让 sortable 与数据
// state 在同一文件管理（更内聚）。
/** 与 UploadStatusCellView.vue::UploadStatusCell 同形，跨文件复用。 */
interface UploadStatusCellViewCell {
  status: 'pending' | 'uploading' | 'done' | 'error';
  progress: number;
  error?: string;
}

const props = defineProps<{
  l1Customers: { id: string; name: string }[];
  l2Customers: { id: string; name: string }[];
  applicantCandidates: { id: string; name: string }[];
  applicantLoading: boolean;
  querySearch: (queryString: string, cb: (items: { id: string; name: string }[]) => void) => void;
  pdfForm: { customerL1Id: string | null; requestDate: string };
  pdfFiles: UploadFile[];
  excelFiles: UploadFile[];
  threeDModelFiles: UploadFile[];
  pdfBuildingTree: boolean;
  pdfSubmitting: boolean;
  allPdfs: { uid: string; raw: Blob; filename: string; totalPages: number; synthesized: boolean }[];
  selectedPages: Set<string>;
  standaloneParts: StandalonePartRow[];
  assemblies: AssemblyRow[];
  totalAssemblyChildren: number;
  sourceTree: SourceTreeRow[];
  pdfPreviewing: PdfPreviewState | null;
  pdfPreviewVisible: boolean;
  manualPartDialogVisible: boolean;
  manualPartForm: { drawing_no: string; name: string; file: File | null };
  manualPartFileList: UploadFile[];
  manualPartFormValid: boolean;
  manualAsmDialogVisible: boolean;
  manualAsmForm: { drawing_no: string; name: string; file: File | null };
  manualAsmFileList: UploadFile[];
  manualAsmFormValid: boolean;
  onPdfChange: (file: UploadFile) => void;
  onPdfRemove: (file: UploadFile) => void;
  onExcelChange: (file: UploadFile) => void;
  onExcelRemove: (file: UploadFile) => void;
  onThreeDModelChange: (file: UploadFile) => void;
  onThreeDModelRemove: (file: UploadFile) => void;
  rebuildFromUploads: () => Promise<void>;
  onUnitPriceChange: (row: StandalonePartRow, v: number | undefined) => void;
  /** 2026-10-05 新增：装配件顶层整套含税单价（联动 total_price = 单价 × 套数）。 */
  onAsmUnitPriceChange: (row: AssemblyRow, v: number | undefined) => void;
  onChildUnitPriceChange: (c: AssemblyChildRow, v: number | undefined) => void;
  onL2Change: (row: { customer_id: string; customer_name?: string }, v: string) => void;
  onAsmPlannedChange: (asmRow: AssemblyRow, v: string) => void;
  previewSourceRow: (row: SourceTreeRow) => void;
  previewStandalonePart: (row: StandalonePartRow) => void;
  previewPdfSourceByUid: (uid: string) => void;
  pdfSourceLabel: (uid: string) => string;
  onSourceSelectionChange: (rows: SourceTreeRow[]) => void;
  clearSelection: (table: { clearSelection: () => void } | null | undefined) => void;
  mergeSelectedAsPart: () => Promise<void>;
  mergeSelectedAsAssembly: () => Promise<void>;
  /** 2026-10-05 新增：实际建出的子件（被指定为总装图的那一页被排除）。 */
  effectiveChildren: (a: AssemblyRow) => AssemblyChildRow[];
  /** 2026-10-05 新增：总装图下拉改值（同时维护 masterPageIndex 与 masterPdfSourceUid）。 */
  onAsmMasterPageChange: (a: AssemblyRow, v: number | null | undefined) => void;
  splitStandalonePart: (row: StandalonePartRow) => void;
  removePdf: (pdfUid: string) => void;
  removeStandalonePart: (uid: string) => void;
  removeAssembly: (uid: string) => void;
  addManualPart: () => void;
  onManualPartFileChange: (file: UploadFile) => void;
  onManualPartFileRemove: () => void;
  confirmManualPart: () => Promise<void>;
  closeManualPartDialog: () => void;
  addManualAssembly: () => void;
  onManualAsmFileChange: (file: UploadFile) => void;
  onManualAsmFileRemove: () => void;
  confirmManualAssembly: () => Promise<void>;
  closeManualAsmDialog: () => void;
  closePdfPreview: () => void;
  // 上传状态（cell + 反查函数 + 全局汇总）
  pdfUploadCells: Record<string, UploadStatusCellViewCell>;
  threeDUploadCells: Record<string, UploadStatusCellViewCell>;
  getRowPdfCell: (row: { pdfSourceUid: string | null }) => UploadStatusCellViewCell | undefined;
  getRowThreeDCell: (row: { three_d_index: number | null }) => UploadStatusCellViewCell | undefined;
  // 2026-10-04：单入口提交流程（建工单 + 逐 part 后置上传）
  commitStage: 'idle' | 'creating' | 'uploading' | 'done';
  canSubmit: boolean;
  submitLabel: string;
  cellRetryDisabled: boolean;
  onSubmit: () => Promise<void>;
  retryFailedUploads: () => Promise<void>;
  retryUploadByCell: (jobKey: string) => Promise<void>;
}>();

// PR-2 2026-09-13：父级三个 form 都是 reactive；vue/no-mutating-props 禁止
// props.form.x = v。本地副本 + watch + emit 双向同步。
// watch immediate: true 触发一次性拷贝，避免在 setup 顶层读 props.*Form。
const emit = defineEmits<{
  (e: 'update:pdf-form', v: { customerL1Id: string | null; requestDate: string }): void;
  (
    e: 'update:manual-part-form' | 'update:manual-asm-form',
    v: { drawing_no: string; name: string; file: File | null },
  ): void;
}>();
const localPdfForm = reactive<{ customerL1Id: string | null; requestDate: string }>({
  customerL1Id: null,
  requestDate: '',
});
const localManualPartForm = reactive<{ drawing_no: string; name: string; file: File | null }>({
  drawing_no: '',
  name: '',
  file: null,
});
const localManualAsmForm = reactive<{ drawing_no: string; name: string; file: File | null }>({
  drawing_no: '',
  name: '',
  file: null,
});
watch(
  () => props.pdfForm,
  (v) => {
    Object.assign(localPdfForm, toRaw(v));
  },
  { deep: true, immediate: true },
);
watch(localPdfForm, (v) => emit('update:pdf-form', { ...v }), { deep: true });
watch(
  () => props.manualPartForm,
  (v) => {
    Object.assign(localManualPartForm, toRaw(v));
  },
  { deep: true, immediate: true },
);
watch(localManualPartForm, (v) => emit('update:manual-part-form', { ...v }), { deep: true });
watch(
  () => props.manualAsmForm,
  (v) => {
    Object.assign(localManualAsmForm, toRaw(v));
  },
  { deep: true, immediate: true },
);
watch(localManualAsmForm, (v) => emit('update:manual-asm-form', { ...v }), { deep: true });

// 源文件区 el-table 本地 ref（用于 clearSelection）。拖拽用 el-table 的 ref
// 由 composable 持有并通过 provide 暴露给本组件。
const sourceTableRefLocal = ref<{ clearSelection: () => void; $el?: HTMLElement } | null>(null);

/** 把 sourceTableRefLocal 传给 composable 的 clearSelection。 */
function handleClearSelection(): void {
  props.clearSelection(sourceTableRefLocal.value);
}

// 2026-08-27：拖拽 ref 由父组件 usePartBatchPdf composable 持有，通过
// provide/inject 取回；本组件负责把 el-table 实例在 :ref 回调里回写。
// composable 必注入（页面顶层必定调用 usePartBatchPdf）；非空断言与 inject
// 类型保持一致，无 fallback（与 WorkerColumn / PoolDrawer 一致：缺失即 dev/prod 立即报错）。
const pdfRefs = inject<{
  standaloneTableRef: Ref<{ $el?: HTMLElement } | null>;
  assembliesTableRef: Ref<{ $el?: HTMLElement } | null>;
}>('partBatchPdfRefs')!;

/** 把模板 :ref 收到的未知值收窄到 el-table 组件实例形状。null 是合法的（卸载时）。 */
function asElTableInstance(el: unknown): { $el?: HTMLElement } | null {
  return el == null ? null : (el as { $el?: HTMLElement });
}

/** 模板 :ref 回调：把 el-table 实例回写到 composable 持有的 ref。 */
function bindStandaloneTableRef(el: unknown): void {
  pdfRefs.standaloneTableRef.value = asElTableInstance(el);
}
function bindAssembliesTableRef(el: unknown): void {
  pdfRefs.assembliesTableRef.value = asElTableInstance(el);
}

// ============ 行内上传重试（按 cell key 定位 job）============
// cell 状态是「按文件」的，`getRowPdfCell` / `getRowThreeDCell` 用的 key 正是
// `UploadJob.jobKey` ⇒ 行内「重试」只需把该 cell 自身的 key 交给 composable，
// 由它筛出这个文件涉及的全部 job 重跑（不会重复建工单）。
//
// 2026-10-05：PDF 一侧的入参放宽到 `string | null` —— 装配件顶层在「无总装图」时
// 传 null（没有可重试的文件），此时不发请求。
function onRetryRowPdf(row: { pdfSourceUid: string | null }): void {
  if (!row.pdfSourceUid) return;
  void props.retryUploadByCell(`pdf:${row.pdfSourceUid}`);
}
function onRetryRowThreeD(row: { pdfSourceUid: string; three_d_index: number | null }): void {
  if (row.three_d_index === null) return;
  const f = props.threeDModelFiles[row.three_d_index];
  if (!f) return;
  void props.retryUploadByCell(`3d:${String(f.uid)}`);
}

/**
 * 子件表行 class：被父行指定为总装图的那一页置灰。
 * 闭包捕获父行 —— el-table 的 `row-class-name` 只给子行，拿不到父行。
 */
function childRowClass(parent: AssemblyRow): (data: { row: AssemblyChildRow }) => string {
  return ({ row }) => (row.page_index === parent.masterPageIndex ? 'is-master-page' : '');
}

// ============ 2026-08-27 T23：列顺序拖动 + 可见性（3 个 el-table）============
// 与 composable 持有的 row-drag（tbody Sortable）独立 —— 列拖挂表头 <tr>（列换序；
// 绑 thead 会变成拖整行，2026-08-27 修正）。
// 「选择 / 拖拽手柄 / 操作(fixed) / expand」列不进 defs，保留为字面量 <el-table-column>。
// 3 个表各自 listKey 独立，互不污染。
//
// 2026-10-05：金额列的 `ElInputNumber` 上限。后端金额列是 `NUMERIC(12,2)`（整数部分
// 10 位），`ElInputNumber` 的 `precision: 2` 只管小数位、不管量级，填到 1e10 会在建单
// 时被 per-item savepoint 判失败（用户看到的是一条 DB 错误）。与同行「数量 / 套数」的
// `max: 9999` 同理，两处金额列统一带上。
const MONEY_MAX = 9999999999.99;
//
// ---- Source table（PDF 源文件区；selection + 2 列 + fixed='right' 操作）----
// 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
const columnDefs_source: ColumnDef[] = [
  {
    key: 'filename',
    label: 'PDF 文件名',
    minWidth: 280,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as SourceTreeRow;
      return h(
        'span',
        {
          class: 'filename-link',
          style: 'cursor: pointer; color: var(--el-color-primary);',
          onClick: () => props.previewSourceRow(r),
        },
        r.filename,
      );
    },
  },
  {
    key: 'pageIndex',
    label: '页',
    minWidth: 60,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as SourceTreeRow;
      return h('span', null, r.pageIndex === null ? r.totalPages : r.pageIndex + 1);
    },
  },
];
const columnVisibility_source = useColumnVisibility(columnDefs_source, {
  listKey: 'part_batch_pdf_source',
});
const drag_source = useColumnDrag(columnDefs_source, { listKey: 'part_batch_pdf_source' });

// ---- Standalone table（独立零件；首列拖拽手柄 + 12 列 + fixed='right' 操作）----
const columnDefs_standalone: ColumnDef[] = [
  {
    key: 'drawing_no',
    label: '图号',
    prop: 'drawing_no',
    minWidth: 140,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as StandalonePartRow;
      return h(ElInput, {
        modelValue: r.drawing_no,
        'onUpdate:modelValue': (v: string | number | undefined) => {
          r.drawing_no = String(v ?? '');
        },
        size: 'small',
        class: { 'is-error': !r.drawing_no },
        placeholder: '必填',
      });
    },
  },
  {
    key: 'name',
    label: '名称',
    prop: 'name',
    minWidth: 160,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as StandalonePartRow;
      return h(ElInput, {
        modelValue: r.name,
        'onUpdate:modelValue': (v: string | number | undefined) => {
          r.name = String(v ?? '');
        },
        size: 'small',
        placeholder: '选填',
      });
    },
  },
  {
    key: 'pdfSourceUid',
    label: '图纸',
    minWidth: 220,
    showOverflowTooltip: true,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as StandalonePartRow;
      return h('div', { class: 'drawing-cell' }, [
        h(
          ElLink,
          {
            type: 'primary',
            underline: 'never',
            class: 'filename-link',
            onClick: () => props.previewStandalonePart(r),
          },
          () => props.pdfSourceLabel(r.pdfSourceUid),
        ),
      ]);
    },
  },
  {
    key: 'quantity',
    label: '数量',
    prop: 'quantity',
    minWidth: 90,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as StandalonePartRow;
      return h(ElInputNumber, {
        modelValue: r.quantity,
        'onUpdate:modelValue': (v: number | undefined) => {
          r.quantity = v ?? 1;
        },
        min: 1,
        max: 9999,
        size: 'small',
        controlsPosition: 'right',
        style: 'width: 90px',
      });
    },
  },
  {
    key: 'unit_price',
    label: '含税单价',
    prop: 'unit_price',
    minWidth: 120,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as StandalonePartRow;
      return h(ElInputNumber, {
        modelValue: r.unit_price,
        'onUpdate:modelValue': (v: number | undefined) => {
          r.unit_price = v ?? null;
        },
        min: 0,
        max: MONEY_MAX,
        precision: 2,
        step: 1,
        size: 'small',
        controlsPosition: 'right',
        placeholder: '可填',
        style: 'width: 110px',
        onChange: (v: number | undefined) => props.onUnitPriceChange(r, v),
      });
    },
  },
  {
    key: 'total_price',
    label: '含税价格',
    prop: 'total_price',
    minWidth: 120,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as StandalonePartRow;
      return h(ElInputNumber, {
        modelValue: r.total_price,
        'onUpdate:modelValue': (v: number | undefined) => {
          r.total_price = v ?? null;
        },
        min: 0,
        max: MONEY_MAX,
        precision: 2,
        step: 1,
        size: 'small',
        controlsPosition: 'right',
        placeholder: '可填',
        style: 'width: 110px',
      });
    },
  },
  {
    key: 'three_d_index',
    label: '3D',
    minWidth: 60,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as StandalonePartRow;
      // cellRender 类型签名为 VNode（非 null）；不挂 3D 时返回空 span。
      if (r.three_d_index == null) return h('span', null);
      return h(ElTag, { type: 'success', size: 'small' }, () => '3D ✓');
    },
  },
  {
    key: 'planned_delivery_date',
    label: '计划交期',
    prop: 'planned_delivery_date',
    minWidth: 160,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as StandalonePartRow;
      return h(ElDatePicker, {
        modelValue: r.planned_delivery_date,
        // 原 v-model 直接绑 string 字段；清空时 el-date-picker emit null，
        // 此处落 ''（业务约定：空串 = 未填）。后续校验 / 提交按 '' 处理。
        'onUpdate:modelValue': (v: string | null | undefined) => {
          r.planned_delivery_date = v ?? '';
        },
        type: 'date',
        valueFormat: 'YYYY-MM-DD',
        size: 'small',
        clearable: true,
        placeholder: '选交期',
        style: 'width: 140px',
      });
    },
  },
  {
    key: 'customer_id',
    label: '分厂',
    minWidth: 160,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as StandalonePartRow;
      return h(
        ElSelect,
        {
          modelValue: r.customer_id,
          // 同上：customer_id 类型为 string；clearable 时 el-select emit null，落 ''。
          'onUpdate:modelValue': (v: string | null | undefined) => {
            r.customer_id = v ?? '';
          },
          placeholder: '选分厂',
          filterable: true,
          clearable: true,
          size: 'small',
          style: 'width: 150px',
          disabled: props.l2Customers.length === 0,
          onChange: (v: string) => props.onL2Change(r, v),
        },
        () => props.l2Customers.map((c) => h(ElOption, { key: c.id, label: c.name, value: c.id })),
      );
    },
  },
  {
    key: 'applicant_name',
    label: '申请人',
    minWidth: 160,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as StandalonePartRow;
      return h(ElAutocomplete, {
        modelValue: r.applicant_name,
        'onUpdate:modelValue': (v: string | number) => {
          r.applicant_name = String(v ?? '');
        },
        valueKey: 'name',
        fetchSuggestions: props.querySearch,
        triggerOnFocus: true,
        debounce: 0,
        loading: props.applicantLoading,
        disabled: !localPdfForm.customerL1Id,
        placeholder: '选填',
        clearable: true,
        size: 'small',
        style: 'width: 150px',
      });
    },
  },
  {
    key: 'is_urgent',
    label: '加急',
    minWidth: 70,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as StandalonePartRow;
      return h(ElSwitch, {
        modelValue: r.is_urgent,
        'onUpdate:modelValue': (v: boolean | string | number) => {
          r.is_urgent = !!v;
        },
      });
    },
  },
  {
    key: 'note',
    label: '备注',
    prop: 'note',
    minWidth: 140,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as StandalonePartRow;
      return h(ElInput, {
        modelValue: r.note,
        'onUpdate:modelValue': (v: string | number | undefined) => {
          r.note = String(v ?? '');
        },
        size: 'small',
        type: 'textarea',
        rows: 1,
        placeholder: '选填',
      });
    },
  },
];
const columnVisibility_standalone = useColumnVisibility(columnDefs_standalone, {
  listKey: 'part_batch_pdf_standalone',
});
const drag_standalone = useColumnDrag(columnDefs_standalone, {
  listKey: 'part_batch_pdf_standalone',
});

// ---- Assemblies table（装配件；首列拖拽手柄 + expand + 10 列 + fixed='right' 操作）----
const columnDefs_assembly: ColumnDef[] = [
  {
    key: 'drawing_no',
    label: '图号',
    prop: 'drawing_no',
    minWidth: 140,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as AssemblyRow;
      return h(ElInput, {
        modelValue: r.drawing_no,
        'onUpdate:modelValue': (v: string | number | undefined) => {
          r.drawing_no = String(v ?? '');
        },
        size: 'small',
      });
    },
  },
  {
    key: 'name',
    label: '名称',
    prop: 'name',
    minWidth: 160,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as AssemblyRow;
      return h(ElInput, {
        modelValue: r.name,
        'onUpdate:modelValue': (v: string | number | undefined) => {
          r.name = String(v ?? '');
        },
        size: 'small',
      });
    },
  },
  {
    key: 'pdfSourceUid',
    label: '图纸',
    minWidth: 220,
    showOverflowTooltip: true,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as AssemblyRow;
      return h('div', { class: 'drawing-cell' }, [
        h(
          ElLink,
          {
            type: 'primary',
            underline: 'never',
            class: 'filename-link',
            onClick: () => props.previewPdfSourceByUid(r.pdfSourceUid),
          },
          () => props.pdfSourceLabel(r.pdfSourceUid),
        ),
      ]);
    },
  },
  {
    key: 'customer_id',
    label: '分厂',
    minWidth: 160,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as AssemblyRow;
      return h(
        ElSelect,
        {
          modelValue: r.customer_id,
          'onUpdate:modelValue': (v: string | null | undefined) => {
            r.customer_id = v ?? '';
          },
          placeholder: '选分厂',
          filterable: true,
          clearable: true,
          size: 'small',
          style: 'width: 150px',
          disabled: props.l2Customers.length === 0,
          onChange: (v: string) => props.onL2Change(r, v),
        },
        () => props.l2Customers.map((c) => h(ElOption, { key: c.id, label: c.name, value: c.id })),
      );
    },
  },
  {
    key: 'applicant_name',
    label: '申请人',
    minWidth: 160,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as AssemblyRow;
      return h(ElAutocomplete, {
        modelValue: r.applicant_name,
        'onUpdate:modelValue': (v: string | number) => {
          r.applicant_name = String(v ?? '');
        },
        valueKey: 'name',
        fetchSuggestions: props.querySearch,
        triggerOnFocus: true,
        debounce: 0,
        loading: props.applicantLoading,
        disabled: !props.pdfForm.customerL1Id,
        placeholder: '选填',
        clearable: true,
        size: 'small',
        style: 'width: 150px',
      });
    },
  },
  {
    key: 'quantity',
    label: '套数',
    prop: 'quantity',
    minWidth: 80,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as AssemblyRow;
      return h(ElInputNumber, {
        modelValue: r.quantity,
        'onUpdate:modelValue': (v: number | undefined) => {
          r.quantity = v ?? 1;
        },
        min: 1,
        max: 9999,
        size: 'small',
        controlsPosition: 'right',
        style: 'width: 85px',
      });
    },
  },
  {
    key: 'unit_price',
    label: '含税单价',
    prop: 'unit_price',
    minWidth: 120,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as AssemblyRow;
      return h(ElInputNumber, {
        modelValue: r.unit_price,
        'onUpdate:modelValue': (v: number | undefined) => {
          r.unit_price = v ?? null;
        },
        min: 0,
        max: MONEY_MAX,
        precision: 2,
        step: 1,
        size: 'small',
        controlsPosition: 'right',
        placeholder: '可填',
        style: 'width: 110px',
        onChange: (v: number | undefined) => props.onAsmUnitPriceChange(r, v),
      });
    },
  },
  {
    key: 'total_price',
    label: '含税价格',
    prop: 'total_price',
    minWidth: 120,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as AssemblyRow;
      return h(ElInputNumber, {
        modelValue: r.total_price,
        'onUpdate:modelValue': (v: number | undefined) => {
          r.total_price = v ?? null;
        },
        min: 0,
        max: MONEY_MAX,
        precision: 2,
        step: 1,
        size: 'small',
        controlsPosition: 'right',
        placeholder: '可填',
        style: 'width: 110px',
      });
    },
  },
  {
    key: 'masterPageIndex',
    label: '装配图（总装图）',
    minWidth: 220,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as AssemblyRow;
      return h(
        ElSelect,
        {
          modelValue: r.masterPageIndex,
          // 2026-10-05：走 composable 的 handler —— masterPageIndex 与 masterPdfSourceUid
          // 成对维护（提交 / 上传 / 状态格都按后者寻址）。
          'onUpdate:modelValue': (v: number | null | undefined) => {
            props.onAsmMasterPageChange(r, v);
          },
          placeholder: '无总装图',
          clearable: true,
          size: 'small',
          style: 'width: 210px',
        },
        () =>
          r.children.map((c) =>
            h(ElOption, {
              key: c.page_index,
              label: `P${c.page_index + 1}（${c.drawing_no || '子件'} · 总装图，该页不再作为子件）`,
              value: c.page_index,
            }),
          ),
      );
    },
  },
  {
    key: 'planned_delivery_date',
    label: '计划交期',
    prop: 'planned_delivery_date',
    minWidth: 160,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as AssemblyRow;
      return h(ElDatePicker, {
        modelValue: r.planned_delivery_date,
        'onUpdate:modelValue': (v: string | null | undefined) => {
          r.planned_delivery_date = v ?? '';
        },
        type: 'date',
        valueFormat: 'YYYY-MM-DD',
        size: 'small',
        clearable: true,
        placeholder: '选交期',
        style: 'width: 140px',
        onChange: (v: string) => props.onAsmPlannedChange(r, v),
      });
    },
  },
  {
    key: 'note',
    label: '备注',
    prop: 'note',
    minWidth: 140,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as AssemblyRow;
      return h(ElInput, {
        modelValue: r.note,
        'onUpdate:modelValue': (v: string | number | undefined) => {
          r.note = String(v ?? '');
        },
        size: 'small',
        type: 'textarea',
        rows: 1,
        placeholder: '选填',
      });
    },
  },
  {
    key: 'children_length',
    // 2026-10-05：按 effectiveChildren 计数（与工具栏表头 totalAssemblyChildren、建单口径
    // 同一口径）。指定了总装图的那一页从子件里排除，这一列若还报 `children.length`，用户
    // 拿它跟表头「共 N 子件」核对会凭空多出一条。表头文案「子件数」无需改：总装图本来
    // 就不是子件，显示「不把它算进来的子件数」正是这个文案的字面含义。
    label: '子件数',
    minWidth: 70,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as AssemblyRow;
      return h('span', null, props.effectiveChildren(r).length);
    },
  },
];
const columnVisibility_assembly = useColumnVisibility(columnDefs_assembly, {
  listKey: 'part_batch_pdf_assembly',
});
const drag_assembly = useColumnDrag(columnDefs_assembly, { listKey: 'part_batch_pdf_assembly' });

// 2026-08-28 改造：3 个 el-table 实例 ref（local sourceTableRefLocal + composable
// 通过 provide/inject 注入的 standaloneTableRef / assembliesTableRef）直接传给
// applyDrag，composable 内部解析表头 + MutationObserver 自愈。旧 watcher 派生
// headerRowRef_* + onMounted 二次绑定的链路已拆掉，「表头未渲染就跳过 applyDrag →
// 永久不绑」失效路径已堵。
onMounted(() => {
  drag_source.applyDrag(sourceTableRefLocal);
  drag_standalone.applyDrag(pdfRefs.standaloneTableRef);
  drag_assembly.applyDrag(pdfRefs.assembliesTableRef);
});
</script>

<style lang="scss" scoped>
.hint {
  color: var(--text-secondary);
  font-size: 13px;
  margin: 0;
  padding: 0 4px;
}

.hint-inline {
  margin-left: 12px;
  color: var(--text-secondary);
  font-size: 12px;
}

.pdf-footer-actions {
  margin-top: 16px;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 12px;
}

.upload-cell {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
}

/* 2026-10-05：装配件无总装图时顶层「主图」列的说明。灰色小字（居中由列的 align 提供），
   与本文件其它灰色提示（.hint / .hint-inline）同一套 var(--text-secondary)。 */
.no-master-hint {
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.4;
}

/* 子件表里被指定为总装图的那一行（不作为子件建出）。用 EP 自带的
   --el-fill-color-light 灰底，不新造 token；!important 是为了压过 EP 表格
   自身的行 / 单元格背景。 */
:deep(.is-master-page),
:deep(.is-master-page .el-table__cell) {
  background-color: var(--el-fill-color-light) !important;
}

/* PR-H 2026-07-28：sortable.js 拖拽视觉 */
.drag-handle {
  cursor: grab;
  color: var(--text-secondary);
  font-size: 16px;
}

/* 图纸列：文件名链接 */
.drawing-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.drag-handle:hover {
  color: var(--el-color-primary);
}
.drag-handle:active {
  cursor: grabbing;
}
:deep(.sortable-ghost) {
  opacity: 0.4;
  background-color: #f0f9ff !important;
}
:deep(.sortable-chosen) {
  background-color: #ecf5ff !important;
}
</style>
