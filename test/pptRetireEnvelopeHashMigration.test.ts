import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { splitSqlStatements } from '../src/db/migrate.js'

/**
 * XIN-1826 (R4-B1 RC fix) — the retire migration
 * `2026-08-07-ppt-collab-frame-payload-hash-canonical-ops.sql` must null the
 * RETIRED whole-envelope payload hash on the ledger REGARDLESS of the backfill
 * `recorded_at` timestamp, while still preserving a genuinely-live canonical hash
 * on the adoption path.
 *
 * The gap Jerry-Xin named: `2026-08-07-backfill-ppt-collab-frame-ledger.sql`
 * inserts a ledger row for every pre-existing `ppt_collab_op` row with NO explicit
 * timestamp, so `recorded_at` defaults to the migration's execution time; then
 * `-payload-hash-bin.sql` stamps the retired whole-envelope hash
 * `SHA2(frame_json,256)` onto those rows. Any env that runs these migrations
 * ON/AFTER the fixed cutoff (`2026-08-07 00:00:00.000`) while `ppt_collab_op`
 * already has rows ends up with backfilled ledger rows carrying
 * `recorded_at >= cutoff` AND the retired hash. The earlier retire predicate nulled
 * solely on `recorded_at < cutoff`, so it NEVER cleared those rows — the runtime
 * then refuses a legitimate idempotent resend as `protocol-version`, the exact
 * "committed edit left permanently unsynced" regression.
 *
 * The fix identifies the retired hash by VALUE (Arm A), not by timestamp, so it is
 * nulled at any `recorded_at`; the `recorded_at < cutoff` guard survives only on the
 * pruned-op fallback (Arm B), where the op row is gone and the value cannot be
 * confirmed. No MySQL engine runs in this suite (unit tests are offline — see
 * vitest.config.ts); real-engine verification of both paths is routed to the
 * integration gate (PR #163). These assertions pin the corrected predicate so the
 * timestamp-only leak cannot silently return.
 */

const MIGRATION = '2026-08-07-ppt-collab-frame-payload-hash-canonical-ops.sql'
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
  'upgrades',
)

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

async function retireUpdateStatements(): Promise<string[]> {
  const sql = await readFile(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8')
  // The retire logic lives in the single procedure body statement; pull the two
  // batch UPDATEs (first-window + subsequent-window) out of it, whitespace-folded.
  const body = splitSqlStatements(sql).find((s) => /CREATE PROCEDURE/i.test(s))
  expect(body, 'retire procedure statement not found').toBeTruthy()
  const updates = collapse(body!).match(/UPDATE ppt_collab_frame\b.*?;/gi) ?? []
  expect(updates.length, 'expected the first-window and subsequent-window UPDATEs').toBe(2)
  return updates
}

describe('PPT retire-envelope-hash migration (XIN-1826)', () => {
  it('nulls the retired whole-envelope hash by VALUE, independent of recorded_at (closes the after-cutoff backfill gap)', async () => {
    for (const update of await retireUpdateStatements()) {
      // Arm A: EXISTS join on (doc_id, frame_id, seq) whose payload_hash equals the
      // whole-envelope SHA2(frame_json,256). This is what catches backfilled rows at
      // recorded_at >= cutoff — the rows the timestamp-only predicate leaked.
      expect(update).toMatch(
        /EXISTS \( SELECT 1 FROM ppt_collab_op o WHERE o\.doc_id = f\.doc_id AND o\.frame_id = f\.frame_id AND o\.seq = f\.seq AND f\.payload_hash = SHA2\(o\.frame_json, 256\) \)/i,
      )
    }
  })

  it('does NOT gate the value-match arm behind recorded_at (a retired hash is nulled at any timestamp)', async () => {
    for (const update of await retireUpdateStatements()) {
      // The ONLY recorded_at reference must be inside the pruned-op fallback arm:
      // `recorded_at < v_cutoff AND NOT EXISTS (... op row ...)`. There must be no
      // second, standalone recorded_at guard that would re-gate the whole null.
      const recordedAtHits = update.match(/recorded_at/gi) ?? []
      expect(recordedAtHits.length, 'recorded_at should appear exactly once (Arm B only)').toBe(1)
      expect(update).toMatch(
        /f\.recorded_at < v_cutoff AND NOT EXISTS \( SELECT 1 FROM ppt_collab_op o WHERE o\.doc_id = f\.doc_id AND o\.frame_id = f\.frame_id AND o\.seq = f\.seq \)/i,
      )
    }
  })

  it('preserves the fixed cutoff literal so the adoption path never nulls a live canonical hash', async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8')
    // A live canonical hash (adoption path) is canonicalPayloadHash(ops), never
    // SHA2(frame_json), so Arm A cannot match it; if its op row was GC'd, Arm B's
    // recorded_at < cutoff keeps it (post-release rows are at/after the cutoff).
    expect(sql).toMatch(/DECLARE v_cutoff DATETIME\(3\) DEFAULT '2026-08-07 00:00:00\.000'/)
  })

  it('keeps the null driven by payload_hash IS NOT NULL and stays inside the keyset window', async () => {
    for (const update of await retireUpdateStatements()) {
      expect(update).toMatch(/WHERE f\.payload_hash IS NOT NULL/i)
      // The batch still bounds itself to the closed keyset window (cursor, batch_max]
      // so cursor advancement is driven by the key, not the hash predicate.
      expect(update).toMatch(/f\.doc_id < v_batch_doc OR \(f\.doc_id = v_batch_doc AND f\.frame_id <= v_batch_frame\)/i)
    }
  })
})
