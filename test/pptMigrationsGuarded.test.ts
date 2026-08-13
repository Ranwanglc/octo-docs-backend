import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
  'upgrades',
)

const BIN_MIGRATION = '2026-08-07-ppt-collab-frame-payload-hash-bin.sql'
const INLINED_SUPERSEDED = '2026-08-08-ppt-collab-frame-frameid-bin-guarded.sql'
const GUARD_SUCCESSOR = '2026-08-09-ppt-collab-frameid-bin-collation-guard.sql'

// The checksum `migrate.ts` recorded for the ORIGINAL pinned bin migration
// (sha256 of the file bytes). A round-23 head commit edited this file in place to
// inline the collation guard, which changed the checksum to 5bd5f392… and made
// `runMigrations` throw on every environment that had already recorded 343b68a9…,
// aborting the whole run (XIN-1783 P1-5). This test pins the file back to its
// recorded checksum so it can never drift again — the guard belongs in a successor.
const PINNED_BIN_SHA256 = '343b68a9da0a2ed1d5ca5757e911395ffb5f3cb83b2e900d0b185915fefb5bfc'

async function readSql(filename: string): Promise<string> {
  return readFile(path.join(MIGRATIONS_DIR, filename), 'utf8')
}

describe('PPT relay migration: frame_id bin collation guard (XIN-1783 P1-5)', () => {
  it('the checksum-pinned bin migration is NOT edited in place (byte-identical to its recorded sha256)', async () => {
    const bytes = await readFile(path.join(MIGRATIONS_DIR, BIN_MIGRATION))
    const sha = createHash('sha256').update(bytes).digest('hex')
    // If this fails, the pinned file was edited and `migrate.ts` will abort on any
    // DB that already recorded the original — add a SUCCESSOR migration instead.
    expect(sha).toBe(PINNED_BIN_SHA256)
  })

  it('the collation guard lives in a dated SUCCESSOR that sorts after the pinned bin migration', async () => {
    // Lexicographic filename order is `migrate.ts`'s execution order; the successor
    // must run AFTER the unguarded rebuild it guards.
    expect(GUARD_SUCCESSOR > BIN_MIGRATION).toBe(true)
    const sql = await readSql(GUARD_SUCCESSOR)

    // Every MODIFY frame_id in the successor is behind an information_schema
    // collation guard, so a re-run on an already-bin column is a no-op (no COPY).
    const body = sql.slice(sql.indexOf('CREATE PROCEDURE'), sql.lastIndexOf('END //'))
    const stripped = body.replace(
      /IF\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+information_schema\.columns[\s\S]*?collation_name\s*<>\s*'utf8mb4_bin'[\s\S]*?END\s+IF\s*;/gi,
      '/*guarded*/',
    )
    expect(stripped.match(/ALTER\s+TABLE[\s\S]*?MODIFY\s+frame_id/gi) ?? []).toEqual([])

    // Both tables' frame_id are covered (one guarded MODIFY each).
    expect(sql.match(/ALTER\s+TABLE[\s\S]*?MODIFY\s+frame_id/gi)).toHaveLength(2)
    expect(sql).toMatch(/ppt_collab_frame/)
    expect(sql).toMatch(/ppt_collab_op/)
  })

  it('does not resurrect the in-place-inlined superseding file that broke the checksum', async () => {
    // The 2026-08-08 file was the head commit's (deleted) inline-guard experiment;
    // the guard now lives in the 2026-08-09 successor, not under that name.
    await expect(readSql(INLINED_SUPERSEDED)).rejects.toThrow(/ENOENT|no such file/)
  })
})
