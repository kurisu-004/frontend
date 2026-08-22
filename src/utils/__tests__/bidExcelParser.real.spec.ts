import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as XLSX from 'xlsx'

import { parseBidExcel } from '../bidExcelParser'

// 加载真实示例文件（应标 Excel）。走 node:fs 读本地路径，
// 不依赖 fetch / @types/node 全量安装（已有 devDependency）。
// 使用 import.meta.url 相对解析 → 不依赖机器绝对路径，CI / 其他 clone 也能跑。
// fixture 与测试同级: src/utils/__tests__/__fixtures__/
const FIXTURE_PATH = fileURLToPath(
  new URL(
    './__fixtures__/供应商招标项目应标 (9).xlsx',
    import.meta.url,
  ),
)

describe('parseBidExcel (real fixture)', () => {
  it('parses 供应商招标项目应标 (9).xlsx', () => {
    const buf = readFileSync(FIXTURE_PATH)
    const wb = XLSX.read(buf, { type: 'buffer' })
    const result = parseBidExcel(wb, '2026-07-13')
    // 26 real data rows, 0 errors
    expect(result.rows).toHaveLength(26)
    expect(result.errors).toEqual([])
    // Spot-check row 0 (黄启福 / 五厂 / E42ZZL521335302)
    const r1 = result.rows[0]
    expect(r1.applicantName).toBe('黄启福')
    expect(r1.deptName).toBe('五厂')
    expect(r1.drawingNo).toBe('E42ZZL521335302')
    expect(r1.deliveryDays).toBe(14)
    expect(r1.plannedDeliveryDate).toBe('2026-07-27')
    expect(r1.isUrgent).toBe(false)
    // 2026-07-30 起批量导入不再自动识别 紧急状态 → 全部 isUrgent=false
    // (用户在前端预览表的 el-switch 单独打开加急)。这里验证：
    // 1) 没有行被自动标为加急；
    // 2) 所有行的 planned_delivery_date 仍是合法 YYYY-MM-DD。
    expect(result.rows.every((r) => r.isUrgent === false)).toBe(true)
    for (const r of result.rows) {
      expect(r.plannedDeliveryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    // 申请人所在一级部门 应该出现多种 (F01/F05/F06/F07/F08/QCZLJLJY)
    const deptNames = new Set(result.rows.map((r) => r.deptName))
    expect(deptNames.size).toBeGreaterThan(1)
  })
})
