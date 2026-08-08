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
const SUPERSEDED = '2026-08-08-ppt-collab-frame-frameid-bin-guarded.sql'

async function readSql(filename: string): Promise<string> {
  return readFile(path.join(MIGRATIONS_DIR, filename), 'utf8')
}

describe('PPT relay migration: frame_id bin collation is guarded (XIN-1776 P1-4)', () => {
  it('the bin migration guards every MODIFY frame_id behind information_schema collation checks', async () => {
    const sql = await readSql(BIN_MIGRATION)

    // Strip IF EXISTS (... information_schema.columns ... collation_name <> 'utf8mb4_bin' ...) END IF
    // blocks (the collation guards). After stripping, no MODIFY frame_id statement may remain:
    // every MODIFY must be inside a guard so re-runs on an already-bin column are no-ops.
    const body = sql.slice(sql.indexOf('CREATE PROCEDURE'), sql.lastIndexOf('END //'))
    const stripped = body.replace(
      /IF\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+information_schema\.columns[\s\S]*?collation_name\s*<>\s*'utf8mb4_bin'[\s\S]*?END\s+IF\s*;/gi,
      '/*guarded*/',
    )
    const bare = stripped.match(/ALTER\s+TABLE[\s\S]*?MODIFY\s+frame_id/gi)
    expect(bare ?? []).toEqual([])

    // Sanity: total MODIFY frame_id == 2 (one per table), both inside guards.
    const all = sql.match(/ALTER\s+TABLE[\s\S]*?MODIFY\s+frame_id/gi)
    expect(all).toHaveLength(2)
  })

  it('does not ship a redundant superseding-guarded migration', async () => {
    // The guard belongs inline in the original file; a second superseding file would be
    // redundant and would run BEFORE the guarded block if filename order got it wrong.
    await expect(readSql(SUPERSEDED)).rejects.toThrow(/ENOENT|no such file/)
  })
})
