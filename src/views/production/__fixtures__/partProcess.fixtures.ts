// 2026-09-14 改造：原 mock seed 拆分。
// FIXTURE_PARTS / FIXTURE_PROCESSES / FIXTURE_FLOWS（composable 阶段一用）已切真接口，删除。
// 保留 FIXTURE_FILES（DrawingPreviewPane.vue 用），保留 mock seed 数据直到后端 /files 接入。
//
// 历史：2026-09-11 新增 partProcess.fixtures.ts（含 5 零件 / 6 工序 / 2 预填流程）；
// 2026-09-14 usePartProcessDesign 切到 @/api/processChain 后，零件 / 工序 / 流程
// 三组 fixture 不再被 composable 引用，仅保留 files 部分（图纸占位）。

// 2026-09-12 新增：通过 Vite ?url 引入 dev 模式测试 PDF，避免 about:blank 占位无内容。
// 生成脚本：scripts/generate-test-pdf.mjs（npm run fixture:pdf）
import sampleDrawing from './sample-drawing.pdf?url';

/** PartFileItem mock（极简字段，仅展示用；不参与业务流程）。 */
export interface MockPartFile {
  id: string;
  file_type: string;
  original_filename: string;
  file_size: number;
  /** 内嵌预览用的占位 blob url；后端真接入后改 `api.get(/part-files/{id}/content, blob)`
      （2026-09-16 更新：v2 无 /files/* 路由） */
  preview_url: string;
}

export const FIXTURE_FILES: Record<string, MockPartFile[]> = {
  '5000000000001': [
    // 法兰盘
    // 2026-09-12 新增：preview_url 用 Vite ?url 引入真实 PDF fixture（npm run fixture:pdf 生成），
    // 替代之前的 'about:blank' 占位，dev:dummy 模式选中即可看到测试 PDF。
    {
      id: 'f-1-1',
      file_type: 'PDF',
      original_filename: 'sample-drawing.pdf',
      file_size: 234567,
      preview_url: sampleDrawing,
    },
    {
      id: 'f-1-2',
      file_type: 'STEP',
      original_filename: '法兰盘.stp',
      file_size: 123456,
      preview_url: '',
    },
    {
      id: 'f-1-3',
      file_type: 'DWG',
      original_filename: '法兰盘-CAD.dwg',
      file_size: 89012,
      preview_url: '',
    },
  ],
  '5000000000002': [
    // 齿轮：暂无 PDF fixture，仍走 about:blank 占位（图 tab 会显示空态）
    {
      id: 'f-2-1',
      file_type: 'PNG',
      original_filename: '齿轮.png',
      file_size: 56789,
      preview_url: '',
    },
  ],
  '5000000000003': [], // 阀体：无图纸
  '5000000000004': [], // 连接轴：无图纸
  '5000000000005': [], // 外壳：无图纸
};
