/**
 * OpenSearch read client for full-text doc search (P4).
 *
 * The independent octo-doc-indexer writes doc/sheet/board bodies into the
 * `octo-doc` index (fields: doc_id / space_id / doc_type / status / share_scope /
 * title / body / updated_at / ver; title & body use the ik analyzer). This module
 * only READS that index — it never writes, never touches the mapping, and holds
 * no permission data.
 *
 * The caller (route) computes the visibility CONSTRAINT in MySQL first (§5.3):
 * a small private/explicitly-granted doc_id set + an isSpaceMember boolean. Those
 * are pushed DOWN into the OS query as a filter (§5.4), so every hit is already
 * within the caller's access — OS does the pagination and no per-hit MySQL
 * re-check is needed (§6.4).
 */
import { Client } from '@opensearch-project/opensearch'
import { config } from '../config/env.js'

let client: Client | null = null

/**
 * Thrown when the caller's visible-doc-id set is larger than the configured
 * bound (config.search.maxVisibleTerms), which would otherwise produce an OS
 * `terms` clause exceeding `index.max_terms_count` and be rejected with an
 * opaque error. The route catches this to return a deterministic 503 with a
 * distinct reason instead of a generic OpenSearch failure.
 */
export class VisibleTermsTooLargeError extends Error {
  constructor(public readonly count: number, public readonly max: number) {
    super(`visible doc set (${count}) exceeds max terms (${max})`)
    this.name = 'VisibleTermsTooLargeError'
  }
}

/**
 * Lazily create the singleton OpenSearch client. Deferred (not built at module
 * load) so importing this file never opens a connection — the client is only
 * constructed the first time a search actually runs (search is default-OFF).
 */
export function getOsClient(): Client {
  if (!client) {
    const { opensearchNode, opensearchUsername, opensearchPassword } = config.search
    // https + explicit opt-out => disable cert verification (escape hatch for an
    // internal self-signed node). http or default (verify on) => no ssl override.
    const ssl =
      opensearchNode.startsWith('https:') && config.search.opensearchTlsRejectUnauthorized === false
        ? { rejectUnauthorized: false }
        : undefined
    if (ssl) {
      // Loud, one-time signal that cert verification is OFF against the store
      // holding every document body — so a deliberate escape hatch is
      // distinguishable from a correctly-configured cluster in the logs, and an
      // accidental one is at least visible (P1-2: strictBool already blocks the
      // typo path, this covers the intentional opt-out).
      // eslint-disable-next-line no-console -- one-time construction-time security signal, same opt-in as bootstrap logging in index.ts
      console.warn(
        `[osClient] OPENSEARCH_TLS_REJECT_UNAUTHORIZED=false: TLS certificate verification is DISABLED for ${opensearchNode}. Only use this for a trusted internal endpoint.`,
      )
    }
    client = new Client({
      node: opensearchNode,
      // Basic auth only when both parts are configured; otherwise omit the header
      // entirely so an unauthenticated dev cluster works with empty creds.
      ...(opensearchUsername !== '' && opensearchPassword !== ''
        ? { auth: { username: opensearchUsername, password: opensearchPassword } }
        : {}),
      ...(ssl ? { ssl } : {}),
    })
  }
  return client
}

/** One result item: business doc_id + display metadata straight from OS `_source`, optional body highlight. */
export interface SearchItem {
  docId: string
  title: string
  docType: string
  updatedAt: number | null
  spaceId: string
  highlight?: string
}

/**
 * A `search_after` sort cursor: the `sort` values of the last hit on a page,
 * in the same order as the query `sort` ([_score, doc_id]). Fed back verbatim
 * as the next page's `search_after` so paging is keyset-stable — no `from`
 * offset that would re-scan (and can skip/duplicate rows under index churn).
 */
export type SearchAfter = Array<string | number>

/**
 * Encode a `search_after` cursor as base64url(JSON({a})). Opaque / URL-safe;
 * the front-end round-trips it verbatim and only the server reads its shape.
 * Mirrors docViewHistoryRepo.encodeViewCursor — same encoding, different payload
 * (the sort tuple rather than a viewed_at/doc_id keyset).
 */
export function encodeSearchCursor(searchAfter: SearchAfter): string {
  const json = JSON.stringify({ a: searchAfter })
  return Buffer.from(json, 'utf8').toString('base64url')
}

/**
 * Decode a `search_after` cursor. Returns null for a missing/empty cursor (=>
 * first page). Throws Error('invalid_cursor') on a malformed cursor so the route
 * can answer 400 rather than silently restarting from the first page (which would
 * loop the client's scroll). Mirrors docViewHistoryRepo.decodeViewCursor. The
 * payload must be a non-empty array of string|number (the [_score, doc_id] sort
 * tuple); anything else is rejected.
 */
export function decodeSearchCursor(raw: string | undefined): SearchAfter | null {
  if (raw === undefined || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new Error('invalid_cursor')
  }
  const a = (parsed as { a?: unknown })?.a
  if (
    !Array.isArray(a) ||
    a.length === 0 ||
    !a.every((v) => typeof v === 'string' || typeof v === 'number')
  ) {
    throw new Error('invalid_cursor')
  }
  return a as SearchAfter
}

/**
 * Minimal shape of the OpenSearch search response we read. The client's own
 * generic types are broad/loose; we narrow to exactly the fields consumed here
 * and read them defensively (any of them may be absent on an odd hit). `sort`
 * carries this hit's sort values (present because the query sets `sort`); the
 * last hit's `sort` becomes the next page's search_after cursor.
 */
interface OsHit {
  _id?: string
  _source?: { doc_id?: string; title?: string; doc_type?: string; updated_at?: number; space_id?: string }
  highlight?: { body?: string[] }
  sort?: Array<string | number>
}
interface OsSearchBody {
  hits?: { total?: { value?: number }; hits?: OsHit[] }
}

/**
 * Run a full-text search against the `octo-doc` index with the caller's visibility
 * constraint pushed down as a filter, keyset-paginated via `search_after` (§5.4 / §6.4).
 *
 *   filter:
 *     - term space_id = spaceId
 *     - term status = 1 (defense-in-depth; visibleDocIds is already status-gated
 *       in MySQL, so this only guards against a stale index entry)
 *     - optional terms doc_type (kind filter)
 *     - terms doc_id IN <visibleDocIds> — the caller's complete visible set
 *       (private + explicitly-granted + space-share), computed live in MySQL.
 *   query: multi_match over title^2 + body (ik-analyzed) + highlight on body.
 *   sort: [_score desc, doc_id asc] — a stable tiebreaker on doc_id makes the
 *     keyset reproducible (no duplicate/skipped rows across pages when scores tie),
 *     which a bare `_score` sort cannot guarantee.
 *
 * Paging: the caller passes the previous page's last `sort` values as `searchAfter`
 * (absent on the first page). We return `searchAfter` = the LAST hit's sort values so
 * the route can mint the next cursor; it is null when this page did not fill `size`
 * (no further page). This replaces `from`/`size` offset paging, which re-scans on
 * every page and can skip or repeat rows when the index changes between requests.
 *
 * Visibility is decided ENTIRELY by the MySQL-computed visibleDocIds; OS no longer
 * carries a share_scope/status truth for permission decisions (that removes the
 * stale-index hazard where a soft-deleted anyone_in_space doc could still match).
 *
 * SHORT-CIRCUIT: an empty visibleDocIds means nothing is visible → returns
 * { total: 0, items: [], searchAfter: null } WITHOUT hitting OS.
 *
 * total is read from hits.total.value (track_total_hits=true so it is exact, not
 * capped at 10k). _source carries title/doc_type/updated_at, so no MySQL round-trip.
 *
 * Throws on any OpenSearch error / unavailability — the route maps that to 503
 * and never fails open to returning everything.
 */
export async function searchDocs(params: {
  spaceId: string
  query: string
  docType?: string[]
  visibleDocIds: string[]
  size: number
  searchAfter?: SearchAfter
}): Promise<{ total: number; items: SearchItem[]; searchAfter: SearchAfter | null }> {
  const visibleDocIds = (params.visibleDocIds ?? []).filter((d) => typeof d === 'string' && d !== '')
  const docTypes = (params.docType ?? []).filter((t) => typeof t === 'string' && t !== '')

  // Visibility = the MySQL-computed visible set only. Empty => nothing visible =>
  // skip OS entirely (§6.4). No share_scope branch: space-share is already folded
  // into visibleDocIds by listVisibleDocIdSet, so OS holds no permission truth.
  if (visibleDocIds.length === 0) return { total: 0, items: [], searchAfter: null }

  // Bound the down-pushed terms list: an oversized `terms doc_id` clause exceeds
  // OpenSearch's index.max_terms_count and is rejected with an opaque error, so
  // fail deterministically here (route -> 503 terms_limit_exceeded) rather than
  // letting a large space silently 503 on the OS round-trip.
  if (visibleDocIds.length > config.search.maxVisibleTerms) {
    throw new VisibleTermsTooLargeError(visibleDocIds.length, config.search.maxVisibleTerms)
  }

  const filter: Array<Record<string, unknown>> = [
    { term: { space_id: params.spaceId } },
    { term: { status: 1 } },
  ]
  if (docTypes.length > 0) filter.push({ terms: { doc_type: docTypes } })
  filter.push({ terms: { doc_id: visibleDocIds } })

  const os = getOsClient()
  const res = await os.search({
    index: config.search.opensearchIndex,
    // track_total_hits so hits.total.value is the exact match count (not capped at
    // 10k), which the response `total` needs to be accurate.
    track_total_hits: true,
    body: {
      size: params.size,
      // Stable keyset sort: primary relevance (_score desc), tiebroken by doc_id
      // asc so equal-score hits have a total order. Without the tiebreaker
      // search_after could skip or repeat rows across pages.
      sort: [{ _score: 'desc' }, { doc_id: 'asc' }],
      // Resume after the previous page's last hit (absent on the first page).
      ...(params.searchAfter ? { search_after: params.searchAfter } : {}),
      _source: ['doc_id', 'title', 'doc_type', 'updated_at', 'space_id'],
      query: {
        bool: {
          must: [
            {
              multi_match: {
                query: params.query,
                fields: ['title^2', 'body'],
              },
            },
          ],
          filter,
        },
      },
      highlight: {
        // encoder:'html' HTML-encodes the document body before wrapping matches
        // in the highlight tags, so a document whose body contains HTML-like
        // text cannot smuggle executable markup through the highlight fragment.
        encoder: 'html',
        fields: { body: {} },
      },
    },
  })
  const body = res.body as OsSearchBody
  const total = body.hits?.total?.value ?? 0
  const hits = body.hits?.hits ?? []
  const items: SearchItem[] = []
  for (const h of hits) {
    // Prefer the stored doc_id source field; fall back to _id (the indexer uses
    // doc_id as the OS document id). Skip a hit with neither.
    const docId = h._source?.doc_id ?? h._id
    if (typeof docId !== 'string' || docId === '') continue
    const fragment = h.highlight?.body?.[0]
    items.push({
      docId,
      title: typeof h._source?.title === 'string' ? h._source.title : '',
      docType: typeof h._source?.doc_type === 'string' ? h._source.doc_type : '',
      updatedAt: typeof h._source?.updated_at === 'number' ? h._source.updated_at : null,
      spaceId: typeof h._source?.space_id === 'string' ? h._source.space_id : '',
      ...(typeof fragment === 'string' && fragment !== '' ? { highlight: fragment } : {}),
    })
  }
  // A full page (hits.length === size) MAY have a further page: carry the last
  // hit's sort values as the next search_after. A short page is the last page —
  // return null so the route omits nextCursor and the client stops. Read `sort`
  // off the raw last hit (not `items`, which may have dropped an id-less hit).
  const lastHit = hits[hits.length - 1]
  const searchAfter =
    hits.length >= params.size && Array.isArray(lastHit?.sort) ? lastHit!.sort! : null
  return { total, items, searchAfter }
}
