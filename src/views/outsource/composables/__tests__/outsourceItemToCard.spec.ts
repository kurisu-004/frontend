// src/views/outsource/composables/__tests__/outsourceItemToCard.spec.ts
//
// 外协看板两个 wire DTO → `BatchCardModel` 适配层的逐字段映射 guard。
//
// 为什么单独守这一层：BatchCard.vue 是全仓唯一的批次卡片、**组件零 DTO 依赖**，DTO 差异
// 全靠本适配层消化。映射写错的表现是「卡片渲染出错误信息」而不是报错（字段名与卡片
// model 同名时更隐蔽：shelf_id 两侧填反、location 语义搞错，卡片照常渲染，只是内容是
// 错的）。
//
// 覆盖：
//   - IC1：候选卡逐字段映射（含 batch_no 的 'B' 前缀、两个 nullable 零件字段的 `?? ''`、
//     location 取 shelf_code、shelf_id 取 DTO 原始值）。
//   - IC2：候选卡 `part_name` / `part_drawing_no` 为 null → 空串（不是 null / '—'）。
//   - IC3：候选卡 extra 三字段（外协公司 / 单价 / 外协工序名来自入参）。
//   - IC4：在途卡逐字段映射（location 取枚举值、shelf_id 恒 null）。
//   - IC5：在途卡 extra 四字段（公司名来自入参 / price / sent_at / can_auto_receive）。
//   - IC6：**两侧差异**守卫 —— shelf_id 候选侧取 DTO、在途侧恒 null；location 候选侧是
//     货架 code、在途侧是 OUTSOURCE_COMPANY 枚举值。
//   - IC7：`PENDING` 未上架的候选（shelf_id 空串）原样透传，不被适配层改写成 null
//     （UI 靠它置灰；改成 null 会让「空串 vs null」两种状态在卡片上不可区分）。
//   - IC8：version 直填（收发写端点的 OCC 锚）。
//   - IC9：has_process_chain（卡片左边框）—— 候选卡透传后端派生列；在途卡恒 false
//     （在途 DTO 无该字段，且外协收发阶段不判链）。
//
// 测试策略：纯函数，无 Vue / Query / api 依赖，直接 import 被测模块。

import { describe, expect, it } from 'vitest';
import { heldBatchToCard, poolCandidateToCard } from '../outsourceItemToCard';
import type {
  OutsourceQueueCandidateDto,
  OutsourceQueueHeldBatchDto,
} from '@/api/outsource.contract';

const candidateFixture: OutsourceQueueCandidateDto = {
  version: 3,
  send_mode: 'APPROVAL',
  part_id: '4000000000001',
  part_serial_no: 'SN-0001',
  part_drawing_no: 'DRW-1',
  part_name: '连杆',
  quantity: 12,
  batch_id: '3000000000001',
  batch_no: 1024,
  planned_delivery_date: '2026-10-20',
  is_urgent: false,
  has_process_chain: true,
  customer_name: '某某零件厂',
  parent_customer_name: '某某集团',
  shelf_code: 'A-01',
  shelf_id: '5000000000001',
  outsource_company_id: '9000000000001',
  outsource_company_name: '外协厂甲',
  quote_id: '7000000000001',
  company_options: [],
  price: '12.50',
  has_cnc_program: true,
  applicant_name: '张三',
  note: null,
  system_delivery_date: '2026-10-18',
  can_send: true,
};

const heldBatchFixture: OutsourceQueueHeldBatchDto = {
  batch_id: '3000000000002',
  part_id: '4000000000002',
  batch_no: 1025,
  quantity: 8,
  serial_no: null,
  drawing_no: 'DRW-2',
  name: '齿轮',
  system_delivery_date: null,
  planned_delivery_date: '2026-10-25',
  is_urgent: true,
  customer_name: '某某零件厂',
  parent_customer_name: null,
  applicant_name: null,
  location: 'OUTSOURCE_COMPANY',
  note: null,
  version: 5,
  sent_at: '2026-10-01T09:00:00',
  price: '8.00',
  receive_next_process_id: '2000000000002',
  receive_next_process_name: '外协热处理',
  chain_resolvable: true,
  has_cnc_program: false,
};

describe('poolCandidateToCard — 左列候选卡 → BatchCardModel', () => {
  it('IC1：逐字段映射正确（batch_no 补 B 前缀，零件字段取 part_* 前缀名）', () => {
    const card = poolCandidateToCard(candidateFixture, '外协-切割');
    expect(card.batch_id).toBe('3000000000001');
    expect(card.part_id).toBe('4000000000001');
    // DTO 里是裸数字 1024，卡片展示串是 B1024
    expect(card.batch_no).toBe('B1024');
    expect(card.part_name).toBe('连杆');
    expect(card.drawing_no).toBe('DRW-1');
    expect(card.serial_no).toBe('SN-0001');
    expect(card.quantity).toBe(12);
    expect(card.system_delivery_date).toBe('2026-10-18');
    expect(card.planned_delivery_date).toBe('2026-10-20');
    expect(card.is_urgent).toBe(false);
    expect(card.has_cnc_program).toBe(true);
    expect(card.has_process_chain).toBe(true);
    // 客户两级：L1 = parent，L2 = leaf
    expect(card.customer_l1).toBe('某某集团');
    expect(card.customer_l2).toBe('某某零件厂');
    expect(card.applicant_name).toBe('张三');
    expect(card.note).toBeNull();
  });

  it('IC2：零件名 / 图号后端可为 null → 空串（卡片 model 要求非空）', () => {
    const card = poolCandidateToCard(
      { ...candidateFixture, part_name: null, part_drawing_no: null },
      '外协-切割',
    );
    expect(card.part_name).toBe('');
    expect(card.drawing_no).toBe('');
    // 占位不是 '—' —— 那是文案不是数据，适配层不许造
    expect(card.part_name).not.toBe('—');
  });

  it('IC3：extra 填外协公司 / 单价 / 外协工序名（后者只能来自入参）', () => {
    const card = poolCandidateToCard(candidateFixture, '外协-切割');
    expect(card.extra).toEqual({
      outsource_company_name: '外协厂甲',
      price: '12.50',
      outsource_process_name: '外协-切割',
    });
    // 候选卡 DTO 上没有工序字段 ⇒ 传 null 时 extra 记 null，不许编一个
    expect(poolCandidateToCard(candidateFixture, null).extra?.outsource_process_name).toBeNull();
  });

  it('IC7：PENDING 未上架候选（shelf_id 空串）原样透传，不被改写成 null', () => {
    // UI 靠 shelf_id 空串把这类行置灰（拖拽发送会被后端 from 守卫拒收）；
    // 适配层把它抹成 null 会让「空串 vs null」在卡片上不可区分。
    const card = poolCandidateToCard(
      { ...candidateFixture, shelf_id: '', shelf_code: null },
      '外协-切割',
    );
    expect(card.shelf_id).toBe('');
    expect(card.location).toBeNull();
  });

  it('IC8：version 直填（收发写端点的 OCC 锚，不落到 extra）', () => {
    const card = poolCandidateToCard(candidateFixture, '外协-切割');
    expect(card.version).toBe(3);
    expect(card.extra).not.toHaveProperty('version');
  });

  it('IC9：has_process_chain 透传后端派生列（卡片左边框的真 / 假两态）', () => {
    expect(poolCandidateToCard(candidateFixture, '外协-切割').has_process_chain).toBe(true);
    expect(
      poolCandidateToCard({ ...candidateFixture, has_process_chain: false }, '外协-切割')
        .has_process_chain,
    ).toBe(false);
  });
});

describe('heldBatchToCard — 右列在途卡 → BatchCardModel', () => {
  it('IC4：逐字段映射正确（零件字段已扁平化，无 part_ 前缀）', () => {
    const card = heldBatchToCard(heldBatchFixture, '外协厂甲');
    expect(card.batch_id).toBe('3000000000002');
    expect(card.batch_no).toBe('B1025');
    expect(card.part_name).toBe('齿轮');
    expect(card.drawing_no).toBe('DRW-2');
    expect(card.serial_no).toBeNull();
    expect(card.quantity).toBe(8);
    expect(card.system_delivery_date).toBeNull();
    expect(card.planned_delivery_date).toBe('2026-10-25');
    expect(card.is_urgent).toBe(true);
    expect(card.has_cnc_program).toBe(false);
    // 在途卡绿边框恒不亮：在途 DTO 无该字段，且适配层刻意不推导（见 IC9b）
    expect(card.has_process_chain).toBe(false);
    expect(card.customer_l1).toBeNull();
    expect(card.customer_l2).toBe('某某零件厂');
    expect(card.version).toBe(5);
  });

  it('IC5：extra 填公司名（入参）/ 单价 / 发出时间 / 接收可免填性', () => {
    const card = heldBatchToCard(heldBatchFixture, '外协厂甲');
    expect(card.extra).toEqual({
      outsource_company_name: '外协厂甲',
      price: '8.00',
      sent_at: '2026-10-01T09:00:00',
      can_auto_receive: true,
    });
    // chain_resolvable = false ⇒ 可免填性 false（UI 必须让用户手填工序 + 货架）
    expect(
      heldBatchToCard({ ...heldBatchFixture, chain_resolvable: false }, '外协厂甲').extra
        ?.can_auto_receive,
    ).toBe(false);
  });

  // 口径锁：在途卡的 has_process_chain 恒 false，**不因任何入参变化**。若将来后端给
  // 在途行也加派生列，这里要改成透传并同步删掉 in-flight 卡片「绿边框不亮」的说明。
  it('IC9b：在途卡恒 false（in-flight DTO 无该字段，且刻意不推导）', () => {
    for (const dto of [
      heldBatchFixture,
      { ...heldBatchFixture, chain_resolvable: false },
      { ...heldBatchFixture, chain_resolvable: true, receive_next_process_id: '0' },
    ]) {
      expect(heldBatchToCard(dto, '外协厂甲').has_process_chain).toBe(false);
    }
  });

  it('IC6：两侧差异 —— 在途卡 location 取枚举值、shelf_id 恒 null', () => {
    const held = heldBatchToCard(heldBatchFixture, '外协厂甲');
    // 批次在外协公司手上（current_holder_id = company_id），没有货架位置
    expect(held.shelf_id).toBeNull();
    expect(held.location).toBe('OUTSOURCE_COMPANY');

    const pool = poolCandidateToCard(candidateFixture, '外协-切割');
    // 候选行的 location 是货架 code，shelf_id 是批次真实所在货架
    expect(pool.location).toBe('A-01');
    expect(pool.shelf_id).toBe('5000000000001');
  });
});