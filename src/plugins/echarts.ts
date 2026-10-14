// vue-echarts 8.3 按需注册模块（2026-09-30 新增）。
// 全仓唯一的 echarts.use() 落点：业务组件只消费全局 <v-chart>，不各自 use、
// 不值导入 echarts/core。下面的集合按站内实际用到的图表 / 组件 / 特性枚举，
// 引全量 echarts 会把约 900KB bundle 拉进来。
//
// v5 主题的副作用 import 绑死在本文件：echarts 6 的默认主题在配色与 legend 默认
// 位置上都与 v5 不同，图表组件统一用 theme="v5" 显式锁回既有视觉，因此主题必须
// 在本模块被加载时就完成注册，图表组件自己不碰主题。
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
