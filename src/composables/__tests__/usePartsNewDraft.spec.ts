// @vitest-environment happy-dom
//
// usePartsNewDraft 单元测试（2026-09-18 frontend-upload-session-pool）。
//
// 验证 parts/new 页面 localStorage 草稿快照 composable：
// - loadDraft：版本不匹配 → null；user_id 不匹配 → null；解析失败 → null
// - saveDraft / clearDraft：localStorage 写入 / 删除
// - mergeDraftWithSession：合并逻辑（命中 done → done / 缺 / 状态非 done → need_reselect）
// - orphan：session.files 存在但不在 snapshot file_links 引用集合
// - debounce saver：多次 schedule 调用合并为一次写入

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MergeResult, PartsNewDraftPayload } from '../usePartsNewDraft';

// ============ helpers ============

function makeDraft(overrides?: Partial<PartsNewDraftPayload>): PartsNewDraftPayload {
  return {
    version: 1,
    user_id: 'user-1',
    saved_at: '2026-09-18T12:00:00Z',
    active_tab: 'pdf',
    pdf_tab: {
      customerL1Id: null,
      requestDate: '2026-09-18',
      rows: [],
      assemblies: [],
      selectedPages: [],
      file_links: [],
    },
    manual_tab: { staged: [] },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

// ============ loadDraft / saveDraft / clearDraft ============

describe('loadDraft / saveDraft / clearDraft', () => {
  it('saveDraft 后 loadDraft 还原完整 payload（含 version + user_id）', async () => {
    const { saveDraft, loadDraft } = await import('../usePartsNewDraft');
    const payload = makeDraft();
    const ok = saveDraft('user-1', payload);
    expect(ok).toBe(true);

    const got = loadDraft('user-1');
    expect(got).not.toBeNull();
    expect(got?.version).toBe(1);
    expect(got?.user_id).toBe('user-1');
    expect(got?.active_tab).toBe('pdf');
    expect(got?.pdf_tab.customerL1Id).toBeNull();
  });

  it('localStorage key 包含 user_id（避免共享账号污染）', async () => {
    const { saveDraft, draftStorageKey, loadDraft } = await import('../usePartsNewDraft');
    expect(draftStorageKey('user-1')).toBe('parts_new:draft:user-1');
    saveDraft('user-1', makeDraft());
    saveDraft('user-2', makeDraft({ user_id: 'user-2' }));
    // 不同 user_id 写入不同 key
    expect(localStorage.getItem('parts_new:draft:user-1')).not.toBeNull();
    expect(localStorage.getItem('parts_new:draft:user-2')).not.toBeNull();
    // load 时只读自己的
    expect(loadDraft('user-1')?.user_id).toBe('user-1');
    expect(loadDraft('user-2')?.user_id).toBe('user-2');
  });

  it('loadDraft：版本不匹配 → null', async () => {
    const { loadDraft } = await import('../usePartsNewDraft');
    // 直接写入一个 version=2 的草稿到 localStorage
    localStorage.setItem('parts_new:draft:user-1', JSON.stringify({ ...makeDraft(), version: 2 }));
    expect(loadDraft('user-1')).toBeNull();
  });

  it('loadDraft：user_id 不匹配 → null', async () => {
    const { saveDraft, loadDraft } = await import('../usePartsNewDraft');
    saveDraft('user-1', makeDraft());
    // 当前 user_id = 'user-2' → 读不到
    expect(loadDraft('user-2')).toBeNull();
  });

  it('loadDraft：解析失败 / 损坏 JSON → null（不抛错）', async () => {
    const { loadDraft } = await import('../usePartsNewDraft');
    localStorage.setItem('parts_new:draft:user-1', '{not valid json');
    expect(loadDraft('user-1')).toBeNull();
  });

  it('loadDraft：缺关键字段 → null', async () => {
    const { loadDraft } = await import('../usePartsNewDraft');
    localStorage.setItem(
      'parts_new:draft:user-1',
      JSON.stringify({ version: 1, user_id: 'user-1' }),
    );
    expect(loadDraft('user-1')).toBeNull();
  });

  it('clearDraft：删除 localStorage key', async () => {
    const { saveDraft, clearDraft, loadDraft } = await import('../usePartsNewDraft');
    saveDraft('user-1', makeDraft());
    expect(loadDraft('user-1')).not.toBeNull();
    clearDraft('user-1');
    expect(loadDraft('user-1')).toBeNull();
  });
});

// ============ mergeDraftWithSession ============

describe('mergeDraftWithSession', () => {
  it('draft=null → 空结果，restored=false；session.files 全部入 orphan', async () => {
    const { mergeDraftWithSession } = await import('../usePartsNewDraft');
    const session = {
      session_id: 'sess-1',
      scope: 'parts_new' as const,
      tmp_prefix: 'tmp/parts_new/',
      bucket: 'bucket',
      region: 'ap-shanghai',
      credentials: {
        tmp_secret_id: 'AK',
        tmp_secret_key: 'SK',
        session_token: 'TK',
        start_time: 0,
        expired_time: 0,
      },
      expires_in: 0,
      files: [
        {
          client_ref: 'r1',
          kind: 'drawing',
          original_filename: 'a.pdf',
          file_size: 1,
          content_type: 'application/pdf',
          content_sha256: 'a'.repeat(64),
          tmp_key: 'tmp/r1',
          status: 'done' as const,
          etag: null,
          uploaded_at: null,
        },
      ],
    };
    const out: MergeResult = mergeDraftWithSession(null, session);
    expect(out.restored).toBe(false);
    expect(out.pdfRows).toEqual([]);
    expect(out.manualStaged).toEqual([]);
    expect(out.orphanFileRefs).toHaveLength(1);
  });

  it('session=null + draft 存在 → restored=true，无 orphan', async () => {
    const { mergeDraftWithSession } = await import('../usePartsNewDraft');
    const draft = makeDraft({
      pdf_tab: {
        customerL1Id: null,
        requestDate: '2026-09-18',
        rows: [
          {
            uid: 'row-1',
            pdfSourceUid: 'pdf-1',
            pageCount: 1,
            drawing_no: 'A-001',
            name: '',
            applicant_name: '',
            customer_id: '',
            customer_name: '',
            request_date: '2026-09-18',
            planned_delivery_date: '',
            system_delivery_date: null,
            order_no: null,
            note: null,
            is_urgent: false,
            quantity: 1,
            unit_price: null,
            total_price: null,
            three_d_index: null,
            drawing_client_ref: 'r1',
            drawing_sha256: 'a'.repeat(64),
          },
        ],
        assemblies: [],
        selectedPages: [],
        file_links: [],
      },
    });
    const out = mergeDraftWithSession(draft, null);
    expect(out.restored).toBe(true);
    expect(out.pdfRows).toHaveLength(1);
    expect(out.pdfRows[0]?.drawing).toBe('need_reselect'); // session=null → no ref match
    expect(out.orphanFileRefs).toEqual([]);
  });

  it('session.files 命中 done → row.drawing=done', async () => {
    const { mergeDraftWithSession } = await import('../usePartsNewDraft');
    const draft = makeDraft({
      pdf_tab: {
        customerL1Id: null,
        requestDate: '2026-09-18',
        rows: [
          {
            uid: 'row-1',
            pdfSourceUid: 'pdf-1',
            pageCount: 1,
            drawing_no: 'A-001',
            name: '',
            applicant_name: '',
            customer_id: '',
            customer_name: '',
            request_date: '2026-09-18',
            planned_delivery_date: '',
            system_delivery_date: null,
            order_no: null,
            note: null,
            is_urgent: false,
            quantity: 1,
            unit_price: null,
            total_price: null,
            three_d_index: null,
            drawing_client_ref: 'r-done',
            drawing_sha256: 'a'.repeat(64),
          },
        ],
        assemblies: [],
        selectedPages: [],
        file_links: [],
      },
    });
    const session = {
      session_id: 'sess-1',
      scope: 'parts_new' as const,
      tmp_prefix: 'tmp/parts_new/',
      bucket: 'bucket',
      region: 'ap-shanghai',
      credentials: {
        tmp_secret_id: 'AK',
        tmp_secret_key: 'SK',
        session_token: 'TK',
        start_time: 0,
        expired_time: 0,
      },
      expires_in: 0,
      files: [
        {
          client_ref: 'r-done',
          kind: 'drawing',
          original_filename: 'a.pdf',
          file_size: 1,
          content_type: 'application/pdf',
          content_sha256: 'a'.repeat(64),
          tmp_key: 'tmp/r-done',
          status: 'done' as const,
          etag: '"abc"',
          uploaded_at: '2026-09-18T12:00:00Z',
        },
      ],
    };
    const out = mergeDraftWithSession(draft, session);
    expect(out.restored).toBe(true);
    expect(out.pdfRows[0]?.drawing).toBe('done');
    expect(out.orphanFileRefs).toEqual([]); // 全部已引用 → 无 orphan
  });

  it('session.files 命中但 status≠done → row.drawing=need_reselect', async () => {
    const { mergeDraftWithSession } = await import('../usePartsNewDraft');
    const draft = makeDraft({
      pdf_tab: {
        customerL1Id: null,
        requestDate: '2026-09-18',
        rows: [
          {
            uid: 'row-1',
            pdfSourceUid: 'pdf-1',
            pageCount: 1,
            drawing_no: 'A-001',
            name: '',
            applicant_name: '',
            customer_id: '',
            customer_name: '',
            request_date: '2026-09-18',
            planned_delivery_date: '',
            system_delivery_date: null,
            order_no: null,
            note: null,
            is_urgent: false,
            quantity: 1,
            unit_price: null,
            total_price: null,
            three_d_index: null,
            drawing_client_ref: 'r-pending',
            drawing_sha256: 'a'.repeat(64),
          },
        ],
        assemblies: [],
        selectedPages: [],
        file_links: [],
      },
    });
    const session = {
      session_id: 'sess-1',
      scope: 'parts_new' as const,
      tmp_prefix: 'tmp/parts_new/',
      bucket: 'bucket',
      region: 'ap-shanghai',
      credentials: {
        tmp_secret_id: 'AK',
        tmp_secret_key: 'SK',
        session_token: 'TK',
        start_time: 0,
        expired_time: 0,
      },
      expires_in: 0,
      files: [
        {
          client_ref: 'r-pending',
          kind: 'drawing',
          original_filename: 'a.pdf',
          file_size: 1,
          content_type: 'application/pdf',
          content_sha256: 'a'.repeat(64),
          tmp_key: 'tmp/r-pending',
          status: 'pending' as const,
          etag: null,
          uploaded_at: null,
        },
      ],
    };
    const out = mergeDraftWithSession(draft, session);
    expect(out.pdfRows[0]?.drawing).toBe('need_reselect');
  });

  it('orphan：session.files 存在但 snapshot 没引用', async () => {
    const { mergeDraftWithSession } = await import('../usePartsNewDraft');
    const draft = makeDraft();
    const session = {
      session_id: 'sess-1',
      scope: 'parts_new' as const,
      tmp_prefix: 'tmp/parts_new/',
      bucket: 'bucket',
      region: 'ap-shanghai',
      credentials: {
        tmp_secret_id: 'AK',
        tmp_secret_key: 'SK',
        session_token: 'TK',
        start_time: 0,
        expired_time: 0,
      },
      expires_in: 0,
      files: [
        {
          client_ref: 'r-orphan',
          kind: 'drawing',
          original_filename: 'a.pdf',
          file_size: 1,
          content_type: 'application/pdf',
          content_sha256: 'a'.repeat(64),
          tmp_key: 'tmp/r-orphan',
          status: 'done' as const,
          etag: null,
          uploaded_at: null,
        },
      ],
    };
    const out = mergeDraftWithSession(draft, session);
    expect(out.orphanFileRefs).toHaveLength(1);
    expect(out.orphanFileRefs[0]?.client_ref).toBe('r-orphan');
  });

  it('assembly 子件也按 client_ref 合并（master + children）', async () => {
    const { mergeDraftWithSession } = await import('../usePartsNewDraft');
    const draft = makeDraft({
      pdf_tab: {
        customerL1Id: null,
        requestDate: '2026-09-18',
        rows: [],
        assemblies: [
          {
            uid: 'asm-1',
            pdfSourceUid: 'pdf-asm',
            drawing_no: 'A',
            name: 'asm',
            applicant_name: '',
            customer_id: '',
            customer_name: '',
            request_date: '2026-09-18',
            planned_delivery_date: '',
            system_delivery_date: null,
            order_no: null,
            note: null,
            is_urgent: false,
            masterPageIndex: null,
            quantity: 1,
            drawing_client_ref: 'r-asm',
            children: [
              {
                uid: 'child-1',
                pdfSourceUid: 'pdf-asm',
                page_index: 0,
                drawing_no: 'A-1',
                name: '',
                quantity: 1,
                is_urgent: false,
                request_date: '2026-09-18',
                planned_delivery_date: '',
                system_delivery_date: null,
                order_no: null,
                note: null,
                unit_price: null,
                total_price: null,
                three_d_index: null,
                drawing_client_ref: 'r-child-done',
              },
              {
                uid: 'child-2',
                pdfSourceUid: 'pdf-asm',
                page_index: 1,
                drawing_no: 'A-2',
                name: '',
                quantity: 1,
                is_urgent: false,
                request_date: '2026-09-18',
                planned_delivery_date: '',
                system_delivery_date: null,
                order_no: null,
                note: null,
                unit_price: null,
                total_price: null,
                three_d_index: null,
                drawing_client_ref: 'r-child-pending',
              },
            ],
          },
        ],
        selectedPages: [],
        file_links: [],
      },
    });
    const session = {
      session_id: 'sess-1',
      scope: 'parts_new' as const,
      tmp_prefix: 'tmp/parts_new/',
      bucket: 'bucket',
      region: 'ap-shanghai',
      credentials: {
        tmp_secret_id: 'AK',
        tmp_secret_key: 'SK',
        session_token: 'TK',
        start_time: 0,
        expired_time: 0,
      },
      expires_in: 0,
      files: [
        {
          client_ref: 'r-asm',
          kind: 'drawing',
          original_filename: 'asm.pdf',
          file_size: 1,
          content_type: 'application/pdf',
          content_sha256: 'a'.repeat(64),
          tmp_key: 'tmp/r-asm',
          status: 'done' as const,
          etag: null,
          uploaded_at: null,
        },
        {
          client_ref: 'r-child-done',
          kind: 'drawing',
          original_filename: 'c1.pdf',
          file_size: 1,
          content_type: 'application/pdf',
          content_sha256: 'a'.repeat(64),
          tmp_key: 'tmp/r-child-done',
          status: 'done' as const,
          etag: null,
          uploaded_at: null,
        },
        {
          client_ref: 'r-child-pending',
          kind: 'drawing',
          original_filename: 'c2.pdf',
          file_size: 1,
          content_type: 'application/pdf',
          content_sha256: 'a'.repeat(64),
          tmp_key: 'tmp/r-child-pending',
          status: 'pending' as const,
          etag: null,
          uploaded_at: null,
        },
      ],
    };
    const out = mergeDraftWithSession(draft, session);
    expect(out.pdfAssemblies).toHaveLength(1);
    const [asm] = out.pdfAssemblies;
    // master row + children
    expect(asm?.children).toHaveLength(3);
    expect(asm?.children[0]?.drawing).toBe('done'); // master
    expect(asm?.children[1]?.drawing).toBe('done'); // child-1 done
    expect(asm?.children[2]?.drawing).toBe('need_reselect'); // child-2 pending
    expect(out.orphanFileRefs).toEqual([]);
  });

  it('manual staged 也按 drawingClientRef 合并', async () => {
    const { mergeDraftWithSession } = await import('../usePartsNewDraft');
    const draft = makeDraft({
      active_tab: 'manual',
      manual_tab: {
        staged: [
          {
            uid: 's-1',
            drawingNo: 'A',
            name: '',
            applicantName: '',
            applicantId: null,
            customerId: null,
            customerLabel: '',
            quantity: 1,
            isUrgent: false,
            requestDate: '2026-09-18',
            plannedDeliveryDate: '',
            orderNo: null,
            systemDeliveryDate: null,
            note: null,
            drawingClientRef: 'r-staged',
          },
        ],
      },
    });
    const session = {
      session_id: 'sess-1',
      scope: 'parts_new' as const,
      tmp_prefix: 'tmp/parts_new/',
      bucket: 'bucket',
      region: 'ap-shanghai',
      credentials: {
        tmp_secret_id: 'AK',
        tmp_secret_key: 'SK',
        session_token: 'TK',
        start_time: 0,
        expired_time: 0,
      },
      expires_in: 0,
      files: [
        {
          client_ref: 'r-staged',
          kind: 'drawing',
          original_filename: 's.pdf',
          file_size: 1,
          content_type: 'application/pdf',
          content_sha256: 'a'.repeat(64),
          tmp_key: 'tmp/r-staged',
          status: 'done' as const,
          etag: null,
          uploaded_at: null,
        },
      ],
    };
    const out = mergeDraftWithSession(draft, session);
    expect(out.manualStaged).toHaveLength(1);
    expect(out.manualStaged[0]?.drawing).toBe('done');
  });
});

// ============ createDraftSaver (debounce) ============

describe('createDraftSaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('多次 schedule 合并为一次写入（500ms debounce）', async () => {
    const { createDraftSaver, loadDraft } = await import('../usePartsNewDraft');
    const saver = createDraftSaver('user-1', 500);

    saver.schedule(makeDraft({ active_tab: 'pdf' }));
    saver.schedule(makeDraft({ active_tab: 'manual' }));
    saver.schedule(makeDraft({ active_tab: 'pdf' }));

    // debounce 内 → 还未写
    expect(loadDraft('user-1')).toBeNull();

    await vi.advanceTimersByTimeAsync(500);
    // 500ms 后写一次（最后一次 schedule 的 payload 为最终值）
    const got = loadDraft('user-1');
    expect(got?.active_tab).toBe('pdf');
  });

  it('flush 立即写入（不等 debounce）', async () => {
    const { createDraftSaver, loadDraft } = await import('../usePartsNewDraft');
    const saver = createDraftSaver('user-1', 500);
    saver.schedule(makeDraft({ active_tab: 'pdf' }));
    saver.flush();
    const got = loadDraft('user-1');
    expect(got?.active_tab).toBe('pdf');
  });

  it('cancel 取消未执行的写入', async () => {
    const { createDraftSaver, loadDraft } = await import('../usePartsNewDraft');
    const saver = createDraftSaver('user-1', 500);
    saver.schedule(makeDraft());
    saver.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(loadDraft('user-1')).toBeNull();
  });
});
