/**
 * Document kind enum (FEAT-B type filter, XIN-1188).
 *
 * The values here are the SINGLE source of truth for `doc_meta.doc_type` and the optional
 * `?type=` filter on the docs list / recent feed. They are authored in lockstep with the frontend
 * enum (octo-web packages/docs/src/pages/docsApi.ts `DOC_TYPES`) — the wire values MUST match
 * verbatim; never accept or emit a kind that isn't in this list.
 *
 * `board` is the whiteboard kind the create path already stamps (see routes/docs.ts
 * WHITEBOARD_DOC_TYPE); `doc` is the rich-text default; `sheet` is the Univer spreadsheet kind;
 * `html` is the registered read-only HTML doc kind (octo-doc, see routes/docs.ts HTML_DOC_TYPE);
 * `html_ppt` is the Bento-backed slide-deck kind (first-class B-owned document type — NOT a
 * C-hosted HTML doc, NOT a Yjs/ProseMirror rich doc). Its collab/version/source paths live under
 * `/api/v1/ppt/**`; it is an EXPLICIT sibling of `html` at every decision site, never a
 * fall-through (see issueCollabToken / contentKindFromDocType / documentName).
 */
export const DOC_TYPES = ['doc', 'sheet', 'board', 'html', 'html_ppt'] as const
export type DocType = (typeof DOC_TYPES)[number]

/**
 * The registered read-only HTML doc kind. Named constant (single source of
 * truth) so the collab-token chokepoint (issueCollabToken) can recognize html
 * docs and clamp their token to read-only without re-hardcoding the wire string.
 */
export const HTML_DOC_TYPE = 'html'

/**
 * The Bento slide-deck kind (`html_ppt`). Named constant, in lockstep with the
 * octo-web `DOC_TYPES` wire value, so every wrong-kind guard (Hocuspocus token
 * reject, legacy create reject, version-restore reject) recognizes PPT without
 * re-hardcoding the wire string.
 */
export const HTML_PPT_DOC_TYPE = 'html_ppt'

/**
 * Whether a doc kind persists an `octo_doc_slug` (the per-space registration
 * slug on `doc_meta`). True for `html` (bot-registered octo-docs) and `html_ppt`
 * (bot-registered PPT rows); human-created rows of either kind pass no slug and
 * store NULL. `doc`/`sheet`/`board` never carry a slug. Single source of truth
 * so the create path (docMetaRepo.create) does not re-hardcode the html string
 * and silently drop a bot PPT slug.
 */
export function docTypeUsesOctoDocSlug(docType: string): boolean {
  return docType === HTML_DOC_TYPE || docType === HTML_PPT_DOC_TYPE
}

const DOC_TYPE_SET: ReadonlySet<string> = new Set(DOC_TYPES)

/** True when `v` is one of the canonical wire kinds. */
export function isDocType(v: unknown): v is DocType {
  return typeof v === 'string' && DOC_TYPE_SET.has(v)
}

/**
 * Normalize a repeated `?type=` query param into a de-duplicated, validated `DocType[]`.
 *
 * Unknown values are dropped rather than rejected: the candidate set is a fixed enum the
 * client writes directly, so a stray value is treated as "no such kind" and simply narrows nothing.
 * An empty result (no param, or only unknown values) means "no type filter" — the caller must then
 * apply NO `doc_type` predicate, preserving the exact pre-FEAT-B behavior (backward compatible).
 */
export function normalizeTypeFilter(input: unknown): DocType[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? [input] : []
  const out: DocType[] = []
  for (const v of raw) {
    if (isDocType(v) && !out.includes(v)) out.push(v)
  }
  return out
}
