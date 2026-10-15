// vue-echarts 8.3 按需注册模块（2026-09-30 新增）。
// 全仓唯一的 echarts.use() 落点：业务组件只消费全局 <v-chart>，不各自 use、
// 不值导入 echarts/core。下面的集合按站内实际用到的图表 / 组件 / 特性枚举，
// 引全量 echarts 会把约 1100KB bundle 拉进来（当前这套装下来约 660KB，
// 其中 core + zrender + v5 主题本身就占 409KB —— 裁图表没有空间了）。
//
// ⚠️ **新增图表 / 组件前先核对站内是否真用到**（2026-10-21）。判据是「站内 4 个
// <v-chart> 宿主的 option 里有没有这个键」，不是「echarts 文档里有这个组件」：
// 逐项的边际成本实测为 Toolbox 45KB / Tooltip 24KB / Grid 21KB / MarkLine 18KB /
// Legend 17KB / Title 2.4KB / Dataset 0KB。据此已摘掉 `ToolboxComponent`、
// `MarkLineComponent`、`DatasetComponent` —— 站内 `toolbox:` / `markLine:` /
// `dataset:` 均为 0 处，摘掉对渲染零影响。
// 「哪些类型真的在用」的核对口径：series 只用了 bar / line / pie（全站 7 处）。
//
// v5 主题的副作用 import 绑死在本文件：echarts 6 的默认主题在配色与 legend 默认
// 位置上都与 v5 不同，图表组件统一用 theme="v5" 显式锁回既有视觉，因此主题必须
// 在本模块被加载时就完成注册，图表组件自己不碰主题。
import 'echarts/theme/v5';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import { LabelLayout, UniversalTransition } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  LabelLayout,
  UniversalTransition,
  CanvasRenderer,
]);

// vue-echarts 8.3 默认从 'vue-echarts' 引入 VChart；仓内走 plugin 全局注册，
// SFC 模板里直接写 <v-chart /> 即可。
import VChart from 'vue-echarts';
export { VChart };
