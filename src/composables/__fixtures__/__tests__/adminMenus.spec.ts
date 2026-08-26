import { describe, it, expect } from 'vitest'
import { ADMIN_MENUS } from '../adminMenus'
import type { MenuNode } from '@/types/menu'

function flatten(nodes: MenuNode[]): MenuNode[] {
  const out: MenuNode[] = []
  for (const n of nodes) {
    out.push(n)
    if (n.children.length > 0) out.push(...flatten(n.children))
  }
  return out
}

describe('ADMIN_MENUS', () => {
  it('covers all 22 menuCodes', () => {
    const all = flatten(ADMIN_MENUS)
    const codes = all.map((n) => n.code)
    expect(codes).toContain('home')
    expect(codes).toContain('parts_list')
    expect(codes).toContain('parts_new')
    expect(codes).toContain('inspection_pending')
    expect(codes).toContain('repair_receive')
    expect(codes).toContain('pending_programming')
    expect(codes).toContain('outsource_companies_list')
    expect(codes).toContain('outsource_quotes_list')
    expect(codes).toContain('outsource_send_receive_list')
    expect(codes).toContain('delivery_notes_manage')
    expect(codes).toContain('workers_list')
    expect(codes).toContain('worker_queue')
    expect(codes).toContain('users_list')
    expect(codes).toContain('shelves_list')
    expect(codes).toContain('customers_list')
    expect(codes).toContain('applicants_list')
    expect(codes).toContain('work_types_list')
    expect(codes).toContain('processes_list')
    expect(codes).toContain('work_type_processes_list')
    expect(codes).toContain('scan_badge')
    expect(codes).toContain('delivery_dispatch')
    expect(codes).toContain('production_stats')
  })

  it('has unique codes (no dup)', () => {
    const all = flatten(ADMIN_MENUS)
    const codes = all.map((n) => n.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('all leaf nodes have path', () => {
    const all = flatten(ADMIN_MENUS)
    const leaves = all.filter((n) => n.children.length === 0)
    for (const leaf of leaves) {
      expect(leaf.path).toBeTruthy()
    }
  })

  it('all ids are strings (snowflake format)', () => {
    const all = flatten(ADMIN_MENUS)
    for (const n of all) {
      expect(typeof n.id).toBe('string')
      expect(n.id.length).toBeGreaterThanOrEqual(15)
    }
  })
})
