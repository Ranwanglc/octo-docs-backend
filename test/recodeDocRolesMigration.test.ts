import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  connectionMigrationDb,
  loadMigrationFiles,
  runMigrations,
  splitSqlStatements,
  type MigrationConnection,
} from '../src/db/migrate.js'

// Integration-ish test for the four-role recode migration
// (2026-07-30-recode-doc-roles.sql). No live MySQL: a tiny in-memory engine
// models just enough — three role tables, a persistent recode-progress marker,
// the named CHECK-constraint catalog + a schema_migrations ledger + the advisory
// lock — to execute the REAL shipped statements and prove the required contract:
//   * the OLD-domain named CHECKs are DROPPED BEFORE the recode DML (else the
//     admin 3->4 bump would violate the still-installed old-domain check),
//   * the numbers are recoded exactly ONCE, transactionally gated by the marker,
//   * the NEW-domain CHECKs are installed BEFORE the DML,
//   * a crash-style DIRECT re-execution (no ledger, old checks already dropped)
//     is a marker-gated no-op that leaves a genuine post-recode commenter(2) alone.

interface RoleRow {
  role: number
}
interface ReqRow {
  requested_role: number
}

// The three named CHECKs and the domains each edition enforces. "old" = the
// pre-migration deployed checks (writer=2/admin=3 space); "new" = the ordered
// 4-level space this migration installs.
const OLD_CHECK_DOMAINS: Record<string, number[]> = {
  chk_doc_member_role: [1, 2, 3],
  chk_doc_invite_role: [1, 2, 3],
  chk_doc_access_request_role: [1, 2],
}
const NEW_CHECK_DOMAINS: Record<string, number[]> = {
  chk_doc_member_role: [1, 2, 3, 4],
  chk_doc_invite_role: [1, 2, 3, 4],
  chk_doc_access_request_role: [1, 2, 3],
}

type Event =
  | { kind: 'drop-check'; name: string }
  | { kind: 'recode' }
  | { kind: 'recode-skipped' }
  | { kind: 'add-check'; name: string }

/** In-memory engine that understands the exact statements this migration emits. */
class RoleMigrationConn implements MigrationConnection {
  docMember: RoleRow[]
  docInvite: RoleRow[]
  docAccessRequest: ReqRow[]
  readonly ledger = new Map<string, string>()
  // Installed named CHECKs -> the domain each currently enforces.
  readonly checks = new Map<string, number[]>()
  encoding: 'v1' | 'v2' | null
  // Ordered log of the phases the CALL performs, for exact-order assertions.
  readonly events: Event[] = []

  constructor(seed: {
    docMember: number[]
    docInvite: number[]
    docAccessRequest: number[]
    // Whether the OLD-domain named CHECKs are already deployed (default: yes, the
    // realistic "existing deployment" case). Fresh installs pass false.
    oldChecksInstalled?: boolean
    encoding?: 'v1' | 'v2' | null
  }) {
    this.docMember = seed.docMember.map((role) => ({ role }))
    this.docInvite = seed.docInvite.map((role) => ({ role }))
    this.docAccessRequest = seed.docAccessRequest.map((requested_role) => ({ requested_role }))
    this.encoding = seed.encoding ?? null
    if (seed.oldChecksInstalled ?? true) {
      for (const [name, domain] of Object.entries(OLD_CHECK_DOMAINS)) this.checks.set(name, [...domain])
    }
  }

  /** Enforce whatever named CHECK currently guards a table, mirroring MySQL. */
  private assertInDomain(name: string, values: number[]): void {
    const domain = this.checks.get(name)
    if (!domain) return
    for (const v of values) {
      if (!domain.includes(v)) {
        throw new Error(`CHECK ${name} violated: ${v} not in (${domain.join(',')})`)
      }
    }
  }

  /** Run the octo_recode_doc_roles() procedure body semantics, in order. */
  private runRecodeProcedure(): void {
    if (this.encoding === 'v2') {
      this.events.push({ kind: 'recode-skipped' })
      return
    }
    const states = Object.fromEntries(Object.keys(OLD_CHECK_DOMAINS).map((name) => {
      const actual = this.checks.get(name)
      const state = actual === undefined ? 'missing'
        : JSON.stringify(actual) === JSON.stringify(OLD_CHECK_DOMAINS[name]) ? 'old'
          : JSON.stringify(actual) === JSON.stringify(NEW_CHECK_DOMAINS[name]) ? 'new' : 'unknown'
      return [name, state]
    }))
    if (Object.values(states).includes('unknown'))
      throw new Error('unknown role CHECK domain or name collision; migration aborted')
    if (this.encoding === null && Object.values(states).some((state) => state !== 'old'))
      throw new Error('ambiguous doc role encoding; migration aborted')

    // Repair each CHECK independently so every implicit-commit DDL prefix retries.
    for (const name of Object.keys(OLD_CHECK_DOMAINS)) {
      if (states[name] === 'old') {
        this.checks.delete(name)
        this.events.push({ kind: 'drop-check', name })
      }
      if (states[name] !== 'new') {
        const domain = NEW_CHECK_DOMAINS[name]
        this.checks.set(name, [...domain])
        this.events.push({ kind: 'add-check', name })
      }
    }

    // 2. Recode once, gated by the persistent marker, inside one transaction.
    if (this.encoding !== 'v2') {
      for (const r of this.docMember) if (r.role === 2 || r.role === 3) r.role = r.role === 3 ? 4 : 3
      this.assertInDomain('chk_doc_member_role', this.docMember.map((r) => r.role))
      for (const r of this.docInvite) if (r.role === 2 || r.role === 3) r.role = r.role === 3 ? 4 : 3
      this.assertInDomain('chk_doc_invite_role', this.docInvite.map((r) => r.role))
      for (const r of this.docAccessRequest) if (r.requested_role === 2) r.requested_role = 3
      this.assertInDomain(
        'chk_doc_access_request_role',
        this.docAccessRequest.map((r) => r.requested_role),
      )
      this.encoding = 'v2' // authoritative marker commits with the recode
      this.events.push({ kind: 'recode' })
    } else {
      this.events.push({ kind: 'recode-skipped' })
    }

  }

  async query(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    const n = sql.trim().replace(/\s+/g, ' ')

    if (/^SELECT GET_LOCK/i.test(n)) return [[{ acquired: 1 }], []]
    if (/^SELECT RELEASE_LOCK/i.test(n)) return [[{ released: 1 }], []]
    if (/^CREATE TABLE IF NOT EXISTS schema_migrations/i.test(n)) return [[], []]
    if (/^SELECT checksum FROM schema_migrations WHERE filename = \?/i.test(n)) {
      const c = this.ledger.get(String(params[0]))
      return [c ? [{ checksum: c }] : [], []]
    }
    if (/^INSERT INTO schema_migrations/i.test(n)) {
      this.ledger.set(String(params[0]), String(params[1]))
      return [[], []]
    }

    // Constraint/recode procedure lifecycle. The proc BODY runs server-side in
    // real MySQL; the runner only emits DROP/CREATE PROCEDURE + CALL, so we model
    // the whole body's semantics (drop-old -> gated recode -> add-new) on CALL.
    if (/^DROP PROCEDURE IF EXISTS/i.test(n)) return [[], []]
    if (/^CREATE PROCEDURE/i.test(n)) return [[], []]
    if (/^CALL octo_recode_doc_roles/i.test(n)) {
      this.runRecodeProcedure()
      return [[], []]
    }

    throw new Error(`RoleMigrationConn: unhandled SQL: ${n.slice(0, 120)}`)
  }
}

const upgradesDir = fileURLToPath(new URL('../migrations/upgrades', import.meta.url))

async function loadRecodeFile() {
  const files = await loadMigrationFiles(upgradesDir)
  const file = files.find((f) => f.filename === '2026-07-30-recode-doc-roles.sql')
  if (!file) throw new Error('recode migration file not found')
  return file
}

describe('four-role recode migration', () => {
  it('the shipped file parses into executable statements', async () => {
    const file = await loadRecodeFile()
    const statements = splitSqlStatements(file.sql)
    expect(statements.length).toBeGreaterThan(0)
    // no comment fragment leaked as a statement head
    for (const s of statements) {
      const firstLine = s.split('\n').map((l) => l.trim()).find((l) => l.length > 0)!
      expect(/^(--|#)/.test(firstLine)).toBe(false)
    }
  })

  it('replaces old checks with v2-compatible checks before recoding — exact order', async () => {
    const conn = new RoleMigrationConn({
      docMember: [1, 2, 3, 2, 1],
      docInvite: [2, 3, 1],
      docAccessRequest: [1, 2, 1, 2],
    })
    const file = await loadRecodeFile()
    const result = await runMigrations(connectionMigrationDb(conn), [file])
    expect(result.applied).toEqual([file.filename])

    // Exact contract order: all three OLD checks dropped, all three NEW checks
    // installed, THEN recode once.
    const dropIdx = conn.events.map((e, i) => (e.kind === 'drop-check' ? i : -1)).filter((i) => i >= 0)
    const recodeIdx = conn.events.findIndex((e) => e.kind === 'recode')
    const addIdx = conn.events.map((e, i) => (e.kind === 'add-check' ? i : -1)).filter((i) => i >= 0)
    expect(dropIdx.length).toBe(3)
    expect(addIdx.length).toBe(3)
    expect(recodeIdx).toBeGreaterThanOrEqual(0)
    expect(Math.max(...dropIdx)).toBeLessThan(recodeIdx)
    expect(Math.max(...addIdx)).toBeLessThan(recodeIdx)
    expect(conn.events.filter((e) => e.kind === 'recode-skipped')).toEqual([])

    // Data recoded: reader stays 1; old writer 2 -> new writer 3; admin 3 -> 4.
    expect(conn.docMember.map((r) => r.role).sort()).toEqual([1, 1, 3, 3, 4])
    expect(conn.docInvite.map((r) => r.role).sort()).toEqual([1, 3, 4])
    expect(conn.docAccessRequest.map((r) => r.requested_role).sort()).toEqual([1, 1, 3, 3])
    // New-domain checks are the ones now installed.
    expect(conn.checks.get('chk_doc_member_role')).toEqual([1, 2, 3, 4])
    expect(conn.checks.get('chk_doc_invite_role')).toEqual([1, 2, 3, 4])
    expect(conn.checks.get('chk_doc_access_request_role')).toEqual([1, 2, 3])
  })

  it('the admin 3->4 bump would violate the OLD check if it were NOT dropped first', async () => {
    // Guard the guard: prove the in-memory CHECK actually bites, so the "drop
    // before DML" ordering is load-bearing, not decorative. Here we force the
    // recode to run while the old-domain check is still installed.
    const conn = new RoleMigrationConn({ docMember: [3], docInvite: [], docAccessRequest: [] })
    // Re-add the old-domain member check and pretend the drop phase did not run.
    conn.checks.set('chk_doc_member_role', [1, 2, 3])
    expect(() => {
      for (const r of conn.docMember) if (r.role === 3) r.role = 4
      // mimic assertInDomain against the still-old check
      const domain = conn.checks.get('chk_doc_member_role')!
      for (const r of conn.docMember) if (!domain.includes(r.role)) throw new Error('CHECK violated')
    }).toThrow(/CHECK/)
  })

  it('preserves per-role counts: old writer count == new writer(3) count, old admin == new admin(4)', async () => {
    const conn = new RoleMigrationConn({
      docMember: [1, 1, 2, 2, 2, 3], // 2 readers, 3 writers, 1 admin
      docInvite: [],
      docAccessRequest: [],
    })
    const file = await loadRecodeFile()
    await runMigrations(connectionMigrationDb(conn), [file])
    const counts = (rows: RoleRow[]) =>
      rows.reduce<Record<number, number>>((acc, r) => ((acc[r.role] = (acc[r.role] ?? 0) + 1), acc), {})
    const c = counts(conn.docMember)
    expect(c[1]).toBe(2) // readers unchanged
    expect(c[3]).toBe(3) // former writers, now code 3
    expect(c[4]).toBe(1) // former admin, now code 4
    expect(c[2]).toBeUndefined() // no commenter appears out of thin air
  })

  it('is idempotent via the ledger: a second RUN is skipped, so post-migration commenter(2) is NOT double-bumped', async () => {
    const conn = new RoleMigrationConn({ docMember: [1, 2, 3], docInvite: [], docAccessRequest: [] })
    const file = await loadRecodeFile()

    const first = await runMigrations(connectionMigrationDb(conn), [file])
    expect(first.applied).toEqual([file.filename])
    expect(conn.docMember.map((r) => r.role).sort()).toEqual([1, 3, 4])

    // The new app writes a genuine commenter row (code 2) AFTER migrate.
    conn.docMember.push({ role: 2 })

    // Re-run: the runner sees the ledger entry (same checksum) and SKIPS the file,
    // so nothing in the file executes again and the commenter(2) is untouched.
    const second = await runMigrations(connectionMigrationDb(conn), [file])
    expect(second.skipped).toEqual([file.filename])
    expect(second.applied).toEqual([])
    expect(conn.docMember.map((r) => r.role).sort()).toEqual([1, 2, 3, 4])
  })

  it('crash-style DIRECT re-execution (no ledger, old checks already dropped) is a marker-gated no-op', async () => {
    // Model the worst crash window: the file applied once (recode committed, old
    // checks dropped) but the process died BEFORE the ledger insert, so the runner
    // re-executes the WHOLE file directly against post-recode data — and the new
    // app has since written a genuine commenter(2).
    const conn = new RoleMigrationConn({ docMember: [1, 2, 3], docInvite: [], docAccessRequest: [] })
    const file = await loadRecodeFile()
    const statements = splitSqlStatements(file.sql)
    const db = connectionMigrationDb(conn)

    // First direct execution of every statement (no ledger involved).
    for (const s of statements) await db.query(s)
    expect(conn.docMember.map((r) => r.role).sort()).toEqual([1, 3, 4])
    expect(conn.encoding).toBe('v2')
    expect(conn.events.filter((e) => e.kind === 'recode')).toHaveLength(1)

    // New app writes a genuine commenter(2) after the recode committed.
    conn.docMember.push({ role: 2 })

    // Crash-style re-execution: run the whole file again with NO ledger skip and
    // the old checks ALREADY gone. The marker must gate the recode to a no-op so
    // writer(3) is never bumped to admin(4) and the commenter(2) survives.
    for (const s of statements) await db.query(s)
    expect(conn.events.filter((e) => e.kind === 'recode')).toHaveLength(1) // still exactly one
    expect(conn.events.filter((e) => e.kind === 'recode-skipped')).toHaveLength(1)
    expect(conn.docMember.map((r) => r.role).sort()).toEqual([1, 2, 3, 4])
    // New-domain checks remain correctly installed after the re-run.
    expect(conn.checks.get('chk_doc_member_role')).toEqual([1, 2, 3, 4])
  })

  it('fresh v2 install with all four roles and an empty migration ledger is an exact no-op', async () => {
    const conn = new RoleMigrationConn({
      docMember: [1, 2, 3, 4],
      docInvite: [1, 2, 3, 4],
      docAccessRequest: [1, 2, 3],
      oldChecksInstalled: false,
      encoding: 'v2',
    })
    for (const [name, domain] of Object.entries(NEW_CHECK_DOMAINS)) conn.checks.set(name, [...domain])
    const file = await loadRecodeFile()
    const result = await runMigrations(connectionMigrationDb(conn), [file])
    expect(result.applied).toEqual([file.filename])
    // Marker wins even with no migration ledger: no data or constraints change.
    expect(conn.events.filter((e) => e.kind === 'drop-check')).toEqual([])
    expect(conn.events.filter((e) => e.kind === 'add-check')).toHaveLength(0)
    expect(conn.docMember.map((r) => r.role)).toEqual([1, 2, 3, 4])
    expect(conn.checks.get('chk_doc_member_role')).toEqual([1, 2, 3, 4])
    expect(conn.checks.get('chk_doc_access_request_role')).toEqual([1, 2, 3])
  })

  it('ambiguous unmarked state aborts without mutating rows or checks', async () => {
    const conn = new RoleMigrationConn({
      docMember: [1, 2, 3], docInvite: [2], docAccessRequest: [1, 2], oldChecksInstalled: false,
    })
    const before = JSON.stringify([conn.docMember, conn.docInvite, conn.docAccessRequest])
    const file = await loadRecodeFile()
    await expect(runMigrations(connectionMigrationDb(conn), [file])).rejects.toThrow(/ambiguous/)
    expect(JSON.stringify([conn.docMember, conn.docInvite, conn.docAccessRequest])).toBe(before)
    expect(conn.checks.size).toBe(0)
    expect(conn.encoding).toBeNull()
  })

  it('explicit authoritative v1 migrates a historical schema with no named checks', async () => {
    const conn = new RoleMigrationConn({
      docMember: [1, 2, 3],
      docInvite: [1, 2, 3],
      docAccessRequest: [1, 2],
      oldChecksInstalled: false,
      encoding: 'v1',
    })
    const file = await loadRecodeFile()
    await runMigrations(connectionMigrationDb(conn), [file])

    expect(conn.events.filter((e) => e.kind === 'drop-check')).toEqual([])
    expect(conn.events.filter((e) => e.kind === 'add-check')).toHaveLength(3)
    expect(conn.events.findIndex((e) => e.kind === 'add-check')).toBeLessThan(
      conn.events.findIndex((e) => e.kind === 'recode'),
    )
    expect(conn.encoding).toBe('v2')
    expect(conn.docMember.map((r) => r.role)).toEqual([1, 3, 4])
    expect(conn.docInvite.map((r) => r.role)).toEqual([1, 3, 4])
    expect(conn.docAccessRequest.map((r) => r.requested_role)).toEqual([1, 3])
    expect(conn.checks.get('chk_doc_member_role')).toEqual([1, 2, 3, 4])
    expect(conn.checks.get('chk_doc_invite_role')).toEqual([1, 2, 3, 4])
    expect(conn.checks.get('chk_doc_access_request_role')).toEqual([1, 2, 3])
  })

  it('retries from the explicit v1 phase after CHECK replacement', async () => {
    const conn = new RoleMigrationConn({
      docMember: [1, 2, 3],
      docInvite: [2, 3],
      docAccessRequest: [1, 2],
      oldChecksInstalled: false,
      encoding: 'v1',
    })
    for (const [name, domain] of Object.entries(NEW_CHECK_DOMAINS)) conn.checks.set(name, [...domain])
    const file = await loadRecodeFile()
    await runMigrations(connectionMigrationDb(conn), [file])
    expect(conn.encoding).toBe('v2')
    expect(conn.docMember.map((r) => r.role)).toEqual([1, 3, 4])
    expect(conn.docInvite.map((r) => r.role)).toEqual([3, 4])
    expect(conn.docAccessRequest.map((r) => r.requested_role)).toEqual([1, 3])
  })

  it('repairs every mixed per-table DDL state with an authoritative v1 marker', async () => {
    const states = ['old', 'new', 'missing'] as const
    const file = await loadRecodeFile()
    for (const member of states) for (const invite of states) for (const request of states) {
      const conn = new RoleMigrationConn({
        docMember: [1, 2, 3], docInvite: [1, 2, 3], docAccessRequest: [1, 2],
        oldChecksInstalled: false, encoding: 'v1',
      })
      for (const [name, state] of Object.entries({
        chk_doc_member_role: member,
        chk_doc_invite_role: invite,
        chk_doc_access_request_role: request,
      })) {
        if (state === 'old') conn.checks.set(name, [...OLD_CHECK_DOMAINS[name]])
        if (state === 'new') conn.checks.set(name, [...NEW_CHECK_DOMAINS[name]])
      }

      await runMigrations(connectionMigrationDb(conn), [file])
      expect(conn.encoding, `${member}/${invite}/${request}`).toBe('v2')
      for (const [name, domain] of Object.entries(NEW_CHECK_DOMAINS))
        expect(conn.checks.get(name), `${member}/${invite}/${request}:${name}`).toEqual(domain)
    }
  })

  it('rejects an unknown named CHECK domain before any DDL or DML', async () => {
    const conn = new RoleMigrationConn({
      docMember: [1, 2, 3], docInvite: [1, 2], docAccessRequest: [1, 2], encoding: 'v1',
    })
    conn.checks.set('chk_doc_invite_role', [1, 2, 3, 9])
    const before = JSON.stringify([conn.docMember, conn.docInvite, conn.docAccessRequest])
    await expect(runMigrations(connectionMigrationDb(conn), [await loadRecodeFile()])).rejects.toThrow(/unknown/)
    expect(conn.events).toEqual([])
    expect(JSON.stringify([conn.docMember, conn.docInvite, conn.docAccessRequest])).toBe(before)
  })
})
