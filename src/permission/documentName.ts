/**
 * documentName parsing and construction (§4.1 step 5 / §8.1 / appendix B).
 *
 * documentName format: `octo:{space}:{folder}:{doc}` (4 segments).
 * Whiteboard key: `octo:{space}:{folder}:wb:{board}` (5 segments, parts[3]==='wb').
 * Html doc registration key: `octo:{space}:{folder}:html:{doc}` (5 segments).
 * PPT (Bento slide-deck) key: `octo:{space}:{folder}:ppt:{doc}` (5 segments, parts[3]==='ppt').
 *
 * parseDocumentName runs an EXECUTABLE validation matrix and REJECTS invalid
 * input (it does NOT do best-effort parsing):
 *   a. asymmetric whiteboard discriminator: 5 segments && parts[3]==='wb' =>
 *      whiteboard key (the document backend does not serve whiteboards).
 *   b. document key must be EXACTLY 4 segments.
 *   c. first segment must === 'octo'.
 *   d. empty segments rejected.
 *   e. {doc} must not contain illegal chars (incl ':') and must not equal 'wb'.
 */

const SEG = /^[A-Za-z0-9_-]+$/

export interface ParsedDocument {
  kind: 'document'
  space: string
  folder: string
  doc: string
}

export interface ParsedWhiteboard {
  kind: 'whiteboard'
  space: string
  folder: string
  board: string
}

export interface ParsedHtmlDocument {
  kind: 'html'
  space: string
  folder: string
  doc: string
}

export interface ParsedPptDocument {
  kind: 'ppt'
  space: string
  folder: string
  doc: string
}

export type ParsedName = ParsedDocument | ParsedWhiteboard | ParsedHtmlDocument | ParsedPptDocument

export class DocumentNameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentNameError'
  }
}

/**
 * Parse and validate a documentName. Throws DocumentNameError on any invalid
 * shape. Whiteboard keys parse to { kind: 'whiteboard' } so callers can reject
 * them explicitly (§4.1 step 5: white-board keys => 4403/4404).
 */
export function parseDocumentName(name: string): ParsedName {
  const parts = name.split(':')

  if (parts[0] !== 'octo') throw new DocumentNameError('bad ns') // first segment must be 'octo'

  // 5 segments && parts[3] === 'wb' => whiteboard key (asymmetric discriminator).
  if (parts.length === 5 && parts[3] === 'wb') {
    const [, space, folder, , board] = parts
    if (![space, folder, board].every((s) => s !== undefined && SEG.test(s))) {
      throw new DocumentNameError('bad seg')
    }
    return { kind: 'whiteboard', space: space!, folder: folder!, board: board! }
  }

  if (parts.length === 5 && parts[3] === 'html') {
    const [, space, folder, , doc] = parts
    if (![space, folder, doc].every((s) => s !== undefined && SEG.test(s))) {
      throw new DocumentNameError('bad seg')
    }
    return { kind: 'html', space: space!, folder: folder!, doc: doc! }
  }

  // 5 segments && parts[3] === 'ppt' => Bento slide-deck (html_ppt) key. Mirrors
  // the html arm: an EXPLICIT namespace so a PPT doc never parses as a 4-seg
  // rich document (which would route it into the Yjs/ProseMirror collab path).
  if (parts.length === 5 && parts[3] === 'ppt') {
    const [, space, folder, , doc] = parts
    if (![space, folder, doc].every((s) => s !== undefined && SEG.test(s))) {
      throw new DocumentNameError('bad seg')
    }
    return { kind: 'ppt', space: space!, folder: folder!, doc: doc! }
  }

  // Otherwise must be EXACTLY 4 segments => document key.
  if (parts.length === 4) {
    const [, space, folder, doc] = parts
    if (![space, folder, doc].every((s) => s !== undefined && SEG.test(s))) {
      throw new DocumentNameError('bad seg')
    }
    if (doc === 'wb') {
      throw new DocumentNameError('doc segment must not be "wb" (ambiguous with whiteboard prefix)')
    }
    return { kind: 'document', space: space!, folder: folder!, doc: doc! }
  }

  throw new DocumentNameError('bad documentName: segment count')
}

/**
 * Build a documentName for a document key (§8.1). Validates each segment so we
 * never persist a key that parseDocumentName would later reject.
 */
export function buildDocumentName(space: string, folder: string, doc: string): string {
  for (const [label, seg] of [
    ['space', space],
    ['folder', folder],
    ['doc', doc],
  ] as const) {
    if (!SEG.test(seg)) throw new DocumentNameError(`invalid ${label} segment: ${seg}`)
  }
  if (doc === 'wb') throw new DocumentNameError('doc segment must not be "wb"')
  return `octo:${space}:${folder}:${doc}`
}

export function buildHtmlDocumentName(space: string, folder: string, doc: string): string {
  for (const [label, seg] of [
    ['space', space],
    ['folder', folder],
    ['doc', doc],
  ] as const) {
    if (!SEG.test(seg)) throw new DocumentNameError(`invalid ${label} segment: ${seg}`)
  }
  return `octo:${space}:${folder}:html:${doc}`
}

/**
 * Build a PPT (Bento slide-deck) documentName (§5 / R6). Mirrors
 * buildHtmlDocumentName, emitting the 5-segment `:ppt:` key. Every PPT surface
 * (create, token, WS handshake, source, publish, comment, index) MUST mint keys
 * through this builder — never hand-concatenate `:ppt:` strings.
 */
export function buildPptDocumentName(space: string, folder: string, doc: string): string {
  for (const [label, seg] of [
    ['space', space],
    ['folder', folder],
    ['doc', doc],
  ] as const) {
    if (!SEG.test(seg)) throw new DocumentNameError(`invalid ${label} segment: ${seg}`)
  }
  return `octo:${space}:${folder}:ppt:${doc}`
}

/**
 * Cross-type consistency guard between a parsed documentName and the persisted
 * `doc_meta.doc_type` (§5). A namespaced key must address a row of the matching
 * kind, so a corrupt key/row pairing is rejected rather than silently served:
 *
 *   - `:ppt:` name  ⇒ doc_type MUST be `html_ppt`
 *   - `:html:` name ⇒ doc_type MUST be `html`
 *   - `:wb:` name   ⇒ doc_type MUST be `board` (mirrors the existing whiteboard
 *     guard in issueCollabToken)
 *
 * The 4-segment `document` namespace is intentionally NOT constrained here: it is
 * shared by `doc` and `sheet` (both plain 4-seg keys), so callers that need to
 * separate those two do it by doc_type directly. Returns true when the pairing is
 * consistent (or not one of the namespaced kinds), false when it is a forbidden
 * mismatch — the caller maps false to 403/404 per its own contract.
 */
export function isDocTypeConsistentWithName(parsed: ParsedName, docType: string): boolean {
  switch (parsed.kind) {
    case 'ppt':
      return docType === 'html_ppt'
    case 'html':
      return docType === 'html'
    case 'whiteboard':
      return docType === 'board'
    case 'document':
      return true
  }
}
