// src/api/parts/__tests__/partOutTypes.spec.ts
//
// 2026-10-10 新增（review 第 1 轮）：`PartOut` 窄投影的**类型真相**守门。
//
// 背景：本轮重构把零件主数据的 30 字段联合类型 `PartItem` 拆成
// `PartDetailDto`（28 字段，= 后端 `PartDetailOut`）与 `PartOutDto`（10 字段，
// = 后端 `PartOut`）。但「写端点返哪个 VO」此前从未逐个核对过 —— 11 个 wrapper
// 声明的是 28 字段的详情 VO，而后端 handler 一律返 `R<PartOut>`，后端一个都不返。
// **没有运行时影响**（这些返回值的消费方一律丢弃，只靠失效链重拉），但它正是本次
// 重构的立项靶子，且同一文件里两种互相矛盾的声明并存（「我按后端 VO 订正过」与
// 「这些端点返回详情 VO」同框）。运行时无感 —— 只能靠类型层 + 源码层钉。
//
// 断言分两层：
//   1. **类型层**（`expectTypeOf`）：由 `npm run typecheck`（vue-tsc，`tsconfig.json`
//      的 include 覆盖 `src/**/*.ts`）真正执行。声明被改回 `PartDetailDto` 时这里
//      编译失败。`vitest run` 下这些调用是运行时 no-op —— 所以配了第 2 层。
//   2. **源码层**（正则扫函数签名）：让 `npm test` 单跑也能红，钉住「这些 wrapper
//      的返回类型字面量」。同 `usePartDetailActions.spec.ts` 的 A9 静态守卫。
//
// 后端真源：backend-rust `src/modules/part/vo/part.rs::PartOut`（10 字段）、
// `src/modules/part/handler/{crud,lifecycle}.rs` 与
// `src/modules/prod/batch/handler/{lifecycle,transition}.rs` 里的
// `Result<Json<R<PartOut>>, AppError>` 返回类型。

import { describe, expect, expectTypeOf, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { PartDetailDto, PartOutDto } from '../crud';
import type { BatchToInspectionOutFE, BatchToShipOutFE } from '../batch';
import type { ScanPickUpResultDto } from '../../productionScan.contract';

/** 后端 `PartOut` 的字段集，逐字对齐（顺序即 VO 声明顺序）。 */
const BACKEND_PART_OUT_KEYS = [
  'id',
  'serial_no',
  'name',
  'drawing_no',
  'status',
  'version',
  'quantity',
  'order_no',
  'updated_at',
  'updated_by',
] as const;

// 键清单同时供类型层（`keyof` 比对）与运行时常量（字段个数）使用。
export type BackendPartOutKey = (typeof BACKEND_PART_OUT_KEYS)[number];

/** 声明成 `PartOut` 的写端点 wrapper（判据 = 后端 handler 的返回类型 `R<PartOut>`）。 */
const PART_OUT_WRAPPERS = [
  'placeOnShelf',
  'releaseFromProgramming',
  'forceCompletePart',
  'scanInspect',
  'deliverPart',
  'scanDeliverPart',
  'completePart',
  'startPartRepair',
  'completePartRepair',
  'repairDispatch',
  'cancelPart',
] as const;

function readSrc(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

/** 从 `export async function NAME(` 取到函数体 `{` 之前的签名片段。 */
function signatureOf(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  expect(start, `找不到 wrapper ${name}`).toBeGreaterThanOrEqual(0);
  return src.slice(start, src.indexOf('{', start));
}

describe('T1：PartOutDto 与后端 PartOut 逐字段对齐（10 字段）', () => {
  it('T1a：keyof PartOutDto 恰为后端 VO 的 10 个键（字段名写错 / 少声明 / 多声明都红）', () => {
    expectTypeOf<keyof PartOutDto>().toEqualTypeOf<BackendPartOutKey>();
  });

  it('T1b：PartOutDto 与 PartDetailDto 是两个不同的类型，且窄投影不能当详情 VO 用', () => {
    expectTypeOf<PartOutDto>().not.toEqualTypeOf<PartDetailDto>();
    // 可赋值性方向也钉死：写端点的返回值**不能**当详情用（少 18 个字段），
    // 消费侧想拿 applicant_name / 价格 / 工艺链 id 时会被这条挡住。
    expectTypeOf<PartOutDto>().not.toMatchTypeOf<PartDetailDto>();
  });
});

describe('T2：写端点 wrapper 的返回类型是 PartOutDto', () => {
  it('T2a：源码签名逐个核对（npm test 单跑也能红）', () => {
    const src = readSrc('../crud.ts');
    for (const name of PART_OUT_WRAPPERS) {
      expect(signatureOf(src, name), `${name} 应返 PartOutDto`).toContain('Promise<PartOutDto>');
    }
  });

  it('T2a2：返详情 VO 的 4 个 wrapper 保持 PartDetailDto（别连这些一起改掉）', () => {
    // 后端 `part/handler/crud.rs` 的 get / by-serial / create / update 确实返
    // `PartDetailOut`。反向守卫：把「窄投影」无差别刷到全部 wrapper 上时这条会红。
    const src = readSrc('../crud.ts');
    for (const name of ['getPart', 'createPart', 'updatePart', 'getPartBySerial'] as const) {
      expect(signatureOf(src, name), `${name} 应返 PartDetailDto`).toContain(
        'Promise<PartDetailDto>',
      );
    }
  });

  it('T2b：批量版的 submitted[].part 同样是 PartOutDto，且带 synced_assembly_id', () => {
    expectTypeOf<BatchToShipOutFE['submitted'][number]['part']>().toEqualTypeOf<PartOutDto>();
    expectTypeOf<BatchToInspectionOutFE['submitted'][number]['part']>().toEqualTypeOf<PartOutDto>();
    // 后端 `ToXxxOut` 的三个字段：part / new_batch_id / synced_assembly_id
    expectTypeOf<keyof BatchToShipOutFE['submitted'][number]>().toEqualTypeOf<
      'part' | 'new_batch_id' | 'synced_assembly_id'
    >();
    expectTypeOf<BatchToInspectionOutFE['submitted'][number]['synced_assembly_id']>().toEqualTypeOf<
      string | null
    >();
  });

  it('T2c：报工台取件的出参 ScanPickUpResultDto 同样是 PartOutDto', () => {
    expectTypeOf<ScanPickUpResultDto>().toEqualTypeOf<PartOutDto>();
  });

  it('T2d：后端 VO 的字段数锚点 = 10（注释里「比详情 VO 少的 18 个字段」依赖这个数）', () => {
    expect(BACKEND_PART_OUT_KEYS).toHaveLength(10);
  });
});
