import { beforeEach, describe, expect, it, vi } from 'vitest'

const execute = vi.fn()
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(),
  getPool: () => ({ execute }),
}))

import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'

describe('docMemberRepo.upsertDirectIfChanged', () => {
  beforeEach(() => execute.mockReset())

  it.each([[1, true], [2, true], [0, false]])('maps affectedRows=%i to changed=%s', async (affectedRows, changed) => {
    execute.mockResolvedValueOnce([{ affectedRows }])
    await expect(docMemberRepo.upsertDirectIfChanged({ docId: 'd', uid: 'u', roleNum: 3, grantedBy: 'bot' }))
      .resolves.toBe(changed)
    expect(execute.mock.calls[0]![0]).toContain('ON DUPLICATE KEY UPDATE')
  })
})
