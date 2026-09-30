// 2026-09-30 新增：vue-echarts 8.3 按需注册模块。
// 全仓统一在此 use() 一次；业务组件只 import VChart，无需各自 use。
// 2026-09-30（review #1）修正：v5 主题副作用 import 绑死到本 plugin，
// 不再依赖 src/components/EChart.vue 顺手 import（CLAUDE.md 已把 EChart.vue
// 标记为「历史兜底壳不再扩展」），后续清理 EChart.vue 时 v5 主题不丢。
import 'echarts/theme/v5';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
} from 'echarts/components';
import { LabelLayout, UniversalTransition } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';

// 与 src/components/EChart.vue:46-60 锁定的 modules 集合对齐（不引入全量 ~900KB）。
echarts.use([
  BarChart,
  LineChart,
  PieChart,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
  LabelLayout,
  UniversalTransition,
  CanvasRenderer,
]);

// vue-echarts 8.3 默认从 'vue-echarts' 引入 VChart；仓内走 plugin 全局注册，
// SFC 模板里直接写 <v-chart /> 即可。
import VChart from 'vue-echarts';
export { VChart };
