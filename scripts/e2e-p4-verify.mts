/**
 * P4 end-to-end integration check: connects to a real MySQL + real OpenSearch and
 * runs the real docMetaRepo.listVisibleDocIdSet (real SQL permission constraints)
 * + searchDocs (real OS query/pagination) across multiple permission scenarios.
 * Only seeds e2e_-prefixed data and cleans up exactly those seeded ids afterwards
 * (precise IN-list delete, not a LIKE prefix). Point it at a dedicated dev/test
 * MySQL — it issues hard DELETEs on doc_meta/doc_member for the seeded ids.
 *
 * Run with tsx inside octo_octo-net, using the mysql / search-opensearch aliases.
 * Auth boundaries are not tested here (covered by unit tests); this exercises the
 * real DB permission SQL + OS ik search + pagination path.
 */
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { searchDocs, getOsClient } from '../src/search/osClient.js'
import { query } from '../src/db/pool.js'

const SP = 'e2e_space'
const SP2 = 'e2e_space2'
const USER = 'e2e_user'
const OTHER = 'e2e_other'
// KW/BODY are intentionally Chinese: they are the search *data* that exercises the
// OpenSearch ik (Chinese) analyzer, not prose. Do not translate.
const KW = '销售报表'
const BODY = '本季度销售报表显示销售额显著增长'

// doc_id -> { scenario, space, owner, share_scope, status, member? }
// osStatus overrides the status written to OS (defaults to status); used to simulate a stale copy the indexer hasn't synced.
const DOCS = [
  { doc_id: 'e2e_own',       space: SP,  owner: USER,  share_scope: 0, status: 1, member: null, desc: 'owner private' },
  { doc_id: 'e2e_mem',       space: SP,  owner: OTHER, share_scope: 0, status: 1, member: 1,    desc: 'doc_member granted reader' },
  { doc_id: 'e2e_share',     space: SP,  owner: OTHER, share_scope: 1, status: 1, member: null, desc: 'anyone_in_space shared' },
  { doc_id: 'e2e_none',      space: SP,  owner: OTHER, share_scope: 0, status: 1, member: null, desc: 'restricted, no grant' },
  { doc_id: 'e2e_arch',      space: SP,  owner: USER,  share_scope: 0, status: 2, member: null, desc: 'owner but archived status=2' },
  { doc_id: 'e2e_os2',       space: SP2, owner: USER,  share_scope: 0, status: 1, member: null, desc: 'owner but different space' },
  // Soft-delete leak regression: a space-share doc is soft-deleted (DB status=0) but
  // OS still holds a stale status=1 copy (the consumer discards acl and never re-reads
  // status). The new logic computes the visible set from MySQL in real time, so this
  // doc must not appear in anyone's visible set → unsearchable even if OS is stale.
  { doc_id: 'e2e_share_del', space: SP,  owner: OTHER, share_scope: 1, status: 0, member: null, osStatus: 1, desc: 'space-share soft-deleted (OS stale status=1)' },
]

async function cleanup() {
  // Precise cleanup by explicit id list. NOTE: `LIKE 'e2e_%'` is WRONG here — in
  // MySQL LIKE, `_` is a single-char wildcard, so it would also match `e2eXfoo`,
  // `e2eabc123`, etc. and hard-DELETE unrelated documents. Enumerate the seeded
  // ids instead so this is exactly the data we created — nothing else.
  const ids = DOCS.map((d) => d.doc_id)
  const ph = ids.map(() => '?').join(', ')
  await query(`DELETE FROM doc_member WHERE doc_id IN (${ph})`, ids)
  await query(`DELETE FROM doc_meta   WHERE doc_id IN (${ph})`, ids)
  const os = getOsClient()
  for (const d of DOCS) {
    try { await os.delete({ index: 'octo-doc', id: d.doc_id }) } catch { /* ignore 404 */ }
  }
}

async function seed() {
  for (const d of DOCS) {
    await query(
      `INSERT INTO doc_meta (doc_id, document_name, title, owner_id, space_id, folder_id, doc_type, status, permission_epoch, share_scope, share_role, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, 'f_e2e', 'doc', ?, 0, ?, 1, ?, '')`,
      [d.doc_id, `octo:${d.space}:f_e2e:${d.doc_id}`, `${KW}-${d.doc_id}`, d.owner, d.space, d.status, d.share_scope, d.owner],
    )
    if (d.member) {
      await query(
        `INSERT INTO doc_member (doc_id, uid, role, granted_by, source) VALUES (?, ?, ?, ?, 1)`,
        [d.doc_id, USER, d.member, d.owner],
      )
    }
  }
  // Index into OS (only status=1, simulating the indexer; e2e_arch is indexed on purpose too, to verify the OS status=1 filter blocks it)
  const os = getOsClient()
  for (const d of DOCS) {
    await os.index({
      index: 'octo-doc',
      id: d.doc_id,
      body: {
        doc_id: d.doc_id, space_id: d.space, doc_type: 'doc',
        status: (d as { osStatus?: number }).osStatus ?? d.status, share_scope: d.share_scope,
        title: `${KW}-${d.doc_id}`, body: BODY,
        updated_at: Date.now(), ver: 1,
      },
    })
  }
  await os.indices.refresh({ index: 'octo-doc' })
}

function eq(name: string, got: unknown, want: unknown): boolean {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  const ok = g === w
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}  got=${g} want=${w}`)
  return ok
}

async function run() {
  console.log('=== cleanup + seed ===')
  await cleanup()
  await seed()
  let allPass = true

  // Scenario 1: caller is a space member — the visible set already folds in space-share in MySQL
  console.log('\n=== Scenario 1: isSpaceMember=true (visible set includes share, excludes soft-deleted) ===')
  const vids1 = await docMetaRepo.listVisibleDocIdSet({ uid: USER, spaceId: SP, isSpaceMember: true })
  allPass = eq('member visible set (own+mem+share; excludes none/arch/other_space/soft-deleted)', vids1.sort(), ['e2e_mem', 'e2e_own', 'e2e_share']) && allPass
  const r1 = await searchDocs({ spaceId: SP, query: KW, visibleDocIds: vids1, size: 50 })
  const ids1 = r1.items.map((i) => i.docId).sort()
  allPass = eq('member search hits (own+mem+share)', ids1, ['e2e_mem', 'e2e_own', 'e2e_share']) && allPass
  allPass = eq('member search total', r1.total, 3) && allPass

  // Scenario 2: caller is NOT a space member — space-share stays out of the visible set (fail-closed)
  console.log('\n=== Scenario 2: isSpaceMember=false (share blocked by MySQL) ===')
  const vids2 = await docMetaRepo.listVisibleDocIdSet({ uid: USER, spaceId: SP, isSpaceMember: false })
  allPass = eq('non-member visible set (own+mem only, no share)', vids2.sort(), ['e2e_mem', 'e2e_own']) && allPass
  const r2 = await searchDocs({ spaceId: SP, query: KW, visibleDocIds: vids2, size: 50 })
  const ids2 = r2.items.map((i) => i.docId).sort()
  allPass = eq('non-member search hits (own+mem only)', ids2, ['e2e_mem', 'e2e_own']) && allPass
  allPass = eq('non-member search total', r2.total, 2) && allPass

  // Scenario 2b (core of this round): a soft-deleted space-share doc — OS still has a
  // stale status=1 copy, but the MySQL visible set (computed in real time with the
  // status=1 filter) already excludes it → not searchable even for a member.
  console.log('\n=== Scenario 2b: soft-delete leak closed (unsearchable even with OS stale) ===')
  allPass = eq('soft-deleted doc not in member visible set', vids1.includes('e2e_share_del'), false) && allPass
  allPass = eq('search results exclude soft-deleted doc', ids1.includes('e2e_share_del'), false) && allPass
  // Negative confirmation: OS really does still hold the stale status=1 copy (proving it's blocked, not just un-indexed).
  const osStale = await getOsClient().get({ index: 'octo-doc', id: 'e2e_share_del' }).then(
    (r) => (r.body._source as { status: number }).status, () => -1,
  )
  allPass = eq('soft-deleted doc in OS is still stale status=1 (blocked by MySQL, not OS)', osStale, 1) && allPass

  // Scenario 3: keyset pagination (member, size=2 across two pages via search_after)
  console.log('\n=== Scenario 3: OS keyset pagination size=2 ===')
  const p1 = await searchDocs({ spaceId: SP, query: KW, visibleDocIds: vids1, size: 2 })
  // Page 2 resumes from page 1's last-hit sort cursor — the keyset contract the
  // route/front-end round-trip via nextCursor. A full page (2 of 2) MUST hand back
  // a searchAfter; the short final page MUST return null so the client stops.
  allPass = eq('page1 total=3(track_total_hits)', p1.total, 3) && allPass
  allPass = eq('page1 returns 2 items', p1.items.length, 2) && allPass
  allPass = eq('page1 (full) hands back a searchAfter cursor', Array.isArray(p1.searchAfter), true) && allPass
  const p2 = await searchDocs({ spaceId: SP, query: KW, visibleDocIds: vids1, size: 2, searchAfter: p1.searchAfter ?? undefined })
  allPass = eq('page2 returns 1 item', p2.items.length, 1) && allPass
  allPass = eq('page2 (short/final) hands back no cursor', p2.searchAfter, null) && allPass
  const pageIds = [...p1.items, ...p2.items].map((i) => i.docId).sort()
  allPass = eq('two pages merged = all 3 items, no dupes/gaps', pageIds, ['e2e_mem', 'e2e_own', 'e2e_share']) && allPass

  // Scenario 4: short-circuit (empty visible set → OS not hit)
  console.log('\n=== Scenario 4: short-circuit (empty visible set) ===')
  const r4 = await searchDocs({ spaceId: SP, query: KW, visibleDocIds: [], size: 50 })
  allPass = eq('short-circuit total=0', r4.total, 0) && allPass
  allPass = eq('short-circuit items empty', r4.items, []) && allPass

  // Scenario 5: space isolation (e2e_os2 in another space does not appear in SP search even when owner=caller)
  console.log('\n=== Scenario 5: space isolation ===')
  const vidsSp2 = await docMetaRepo.listVisibleDocIdSet({ uid: USER, spaceId: SP, isSpaceMember: true })
  allPass = eq('SP visible set excludes e2e_os2 from another space', vidsSp2.includes('e2e_os2'), false) && allPass

  // Scenario 6: ik Chinese tokenizer hits the body (using '增长', a word only in body, not title)
  console.log('\n=== Scenario 6: ik body search ===')
  const r6 = await searchDocs({ spaceId: SP, query: '增长', visibleDocIds: vids1, size: 50 })
  allPass = eq('ik body search for the body-only term hits (proves body index + ik work)', r6.items.length > 0, true) && allPass
  allPass = eq('highlight fragment present', typeof r6.items[0]?.highlight === 'string', true) && allPass

  // Scenario 7: docType filter
  console.log('\n=== Scenario 7: docType filter ===')
  const rT = await searchDocs({ spaceId: SP, query: KW, docType: ['sheet'], visibleDocIds: vids1, size: 50 })
  allPass = eq('docType=sheet filter yields 0 hits (all seeded are doc)', rT.items.length, 0) && allPass

  console.log('\n=== cleanup ===')
  await cleanup()

  console.log(`\n====== ${allPass ? 'ALL PASS ✅' : 'SOME FAIL ❌'} ======`)
  process.exit(allPass ? 0 : 1)
}

run().catch(async (e) => {
  console.error('ERROR', e)
  try { await cleanup() } catch { /* ignore */ }
  process.exit(2)
})
