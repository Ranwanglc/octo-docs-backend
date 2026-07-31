import type { DocType } from '../../db/docType.js'

const MAX_ANCHOR_BYTES = 4096
const MAX_BOARD_ID_LENGTH = 256
const MAX_BOARD_ELEMENT_IDS = 100
const MAX_BOARD_COORDINATE = 1_000_000

export type BoardAnchor =
  | { version: 1; kind: 'element'; elementId: string; elementIds?: string[]; x: number; y: number }
  | { version: 1; kind: 'point'; x: number; y: number }

function decodeStrictBase64(raw: unknown): Buffer | null {
  if (typeof raw !== 'string' || raw === '' || raw.length % 4 !== 0) return null
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) return null
  const decoded = Buffer.from(raw, 'base64')
  if (decoded.length === 0 || decoded.length > MAX_ANCHOR_BYTES) return null
  return decoded.toString('base64') === raw ? decoded : null
}

function validElementId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_BOARD_ID_LENGTH &&
    // IDs are opaque, but controls/whitespace are never valid Excalidraw ids.
    !Array.from(value).some((char) => {
      const code = char.charCodeAt(0)
      return /\s/.test(char) || code < 0x20 || (code >= 0x7f && code <= 0x9f)
    })
}

function validCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_BOARD_COORDINATE
}

/** Parse the frontend's canonical versioned board anchor with strict bounds. */
export function parseBoardAnchor(decoded: Buffer): BoardAnchor | null {
  let value: unknown
  try {
    value = JSON.parse(decoded.toString('utf8'))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const anchor = value as Record<string, unknown>
  if (anchor.version !== 1 || !validCoordinate(anchor.x) || !validCoordinate(anchor.y)) return null

  const keys = Object.keys(anchor).sort().join(',')
  if (anchor.kind === 'point' && keys === 'kind,version,x,y') {
    return { version: 1, kind: 'point', x: anchor.x, y: anchor.y }
  }
  if (anchor.kind !== 'element' || !validElementId(anchor.elementId)) return null

  let elementIds: string[] | undefined
  if (anchor.elementIds !== undefined) {
    if (!Array.isArray(anchor.elementIds) || anchor.elementIds.length === 0 ||
        anchor.elementIds.length > MAX_BOARD_ELEMENT_IDS ||
        !anchor.elementIds.every(validElementId)) return null
    elementIds = anchor.elementIds
    if (new Set(elementIds).size !== elementIds.length || !elementIds.includes(anchor.elementId)) return null
  }
  const expectedKeys = elementIds
    ? 'elementId,elementIds,kind,version,x,y'
    : 'elementId,kind,version,x,y'
  if (keys !== expectedKeys) return null
  return {
    version: 1,
    kind: 'element',
    elementId: anchor.elementId,
    ...(elementIds ? { elementIds } : {}),
    x: anchor.x,
    y: anchor.y,
  }
}

export type AnchorPairResult =
  | { ok: true; start: Buffer; end: Buffer }
  | { ok: false; error: 'invalid_anchor' | 'board_anchor_required' | 'board_anchor_not_allowed' | 'inconsistent_anchors' }

export function validateExplicitCommentAnchors(
  docType: DocType,
  rawStart: unknown,
  rawEnd: unknown,
): AnchorPairResult {
  const start = decodeStrictBase64(rawStart)
  const end = decodeStrictBase64(rawEnd)
  if (!start || !end) return { ok: false, error: 'invalid_anchor' }

  const boardStart = parseBoardAnchor(start)
  const boardEnd = parseBoardAnchor(end)
  if (docType !== 'board') {
    if (boardStart || boardEnd) return { ok: false, error: 'board_anchor_not_allowed' }
    return { ok: true, start, end }
  }
  if (!boardStart || !boardEnd) return { ok: false, error: 'board_anchor_required' }
  // Board anchors identify one target rather than a text range. Keep both DB
  // columns for compatibility, but require an identical logical target.
  if (JSON.stringify(boardStart) !== JSON.stringify(boardEnd)) {
    return { ok: false, error: 'inconsistent_anchors' }
  }
  return { ok: true, start, end }
}
