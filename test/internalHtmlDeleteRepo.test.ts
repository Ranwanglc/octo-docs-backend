import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Row {
  doc_id: string
  document_name: string
  owner_id: string
  status: number
  permission_epoch: number
}

const h = vi.hoisted(() => ({
  row: null as Row | null,
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  tail: Promise.resolve(),
}))

vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (tx: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }) => Promise<unknown>) => {
    let release!: () => void
    const previous = h.tail
    h.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await fn({
        query: async (sql: string, params: unknown[] = []) => {
          h.calls.push({ sql, params })
          if (/SELECT[\s\S]*FOR UPDATE/i.test(sql)) return h.row ? [{ ...h.row }] : []
          if (/UPDATE doc_meta/i.test(sql) && h.row && h.row.status === 1) {
            h.row.status = 0
            h.row.permission_epoch += 1
          }
          return []
        },
      })
    } finally {
      release()
    }
  }),
}))

import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'

const active = (): Row => ({
  doc_id: 'd_html',
  document_name: 'octo:space-1:f_default:html:d_html',
  owner_id: 'user-1',
  status: 1,
  permission_epoch: 7,
})

beforeEach(() => {
  h.row = active()
  h.calls.length = 0
  h.tail = Promise.resolve()
})

describe('docMetaRepo.deleteHtmlRegistration', () => {
  it('returns owner_conflict without writing or bumping', async () => {
    const result = await docMetaRepo.deleteHtmlRegistration('space-1', 'page', 'other-user')

    expect(result).toEqual({ outcome: 'owner_conflict' })
    expect(h.row).toMatchObject({ status: 1, permission_epoch: 7 })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].sql).toMatch(/space_id\s*=\s*\?[\s\S]*octo_doc_slug\s*=\s*\?[\s\S]*doc_type\s*=\s*'html'[\s\S]*FOR UPDATE/i)
  })

  it('serializes repeated deletes so exactly one deletes and bumps once', async () => {
    const [first, second] = await Promise.all([
      docMetaRepo.deleteHtmlRegistration('space-1', 'page', 'user-1'),
      docMetaRepo.deleteHtmlRegistration('space-1', 'page', 'user-1'),
    ])

    expect([first.outcome, second.outcome].sort()).toEqual(['deleted', 'not_found_or_deleted'])
    expect(h.row).toMatchObject({ status: 0, permission_epoch: 8 })
    const writes = h.calls.filter(({ sql }) => /UPDATE doc_meta/i.test(sql))
    expect(writes).toHaveLength(1)
    expect(writes[0].sql).toMatch(/owner_id\s*=\s*\?[\s\S]*doc_type\s*=\s*'html'[\s\S]*status\s*=\s*1/i)
  })

  it('locks the slug row so a revival ordered before delete is deleted, not lost', async () => {
    h.row!.status = 0
    let releaseRevival!: () => void
    const revivalLocked = new Promise<void>((resolve) => { releaseRevival = resolve })

    const revival = (async () => {
      let release!: () => void
      const previous = h.tail
      h.tail = new Promise<void>((resolve) => { release = resolve })
      await previous
      h.row!.status = 1
      await revivalLocked
      release()
    })()

    const deletion = docMetaRepo.deleteHtmlRegistration('space-1', 'page', 'user-1')
    releaseRevival()
    await revival

    await expect(deletion).resolves.toMatchObject({ outcome: 'deleted' })
    expect(h.row).toMatchObject({ status: 0, permission_epoch: 8 })
  })
})
