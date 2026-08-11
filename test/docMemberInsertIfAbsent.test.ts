import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/db/pool.js', () => ({ query: vi.fn(), getPool: vi.fn() }))

import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'

describe('docMemberRepo.insertDirectIfAbsentTx', () => {
  it.each([[1, true], [0, false]] as const)(
    'maps mysql2 INSERT IGNORE affectedRows=%s to changed=%s',
    async (affectedRows, changed) => {
      const tx = { execute: vi.fn().mockResolvedValue({ affectedRows }) }
      await expect(docMemberRepo.insertDirectIfAbsentTx(tx as never, {
        docId: 'd_1', uid: 'u_human', roleNum: 3, grantedBy: 'bot_1',
      })).resolves.toBe(changed)
      expect(tx.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT IGNORE INTO doc_member'), [
        'd_1', 'u_human', 3, 'bot_1',
      ])
    },
  )
})