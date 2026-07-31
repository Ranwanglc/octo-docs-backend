import { describe, expect, it } from 'vitest'
import { parseBoardAnchor, validateExplicitCommentAnchors } from '../src/api/services/commentAnchors.js'

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64')

describe('board comment anchors', () => {
  it('accepts canonical versioned element, group, and point pairs', () => {
    const element = b64({ version: 1, kind: 'element', elementId: 'shape_1', x: 10, y: 20 })
    expect(validateExplicitCommentAnchors('board', element, element).ok).toBe(true)
    const group = b64({ version: 1, kind: 'element', elementId: 'a', elementIds: ['a', 'b'], x: 1, y: 2 })
    expect(validateExplicitCommentAnchors('board', group, group).ok).toBe(true)
    const point = b64({ version: 1, kind: 'point', x: 0, y: -2.5 })
    expect(validateExplicitCommentAnchors('board', point, point).ok).toBe(true)
  })

  it('rejects unknown versions, extra fields, invalid ids, groups, and points', () => {
    const invalid = [
      { version: 2, kind: 'element', elementId: 'a', x: 0, y: 0 },
      { version: 1, kind: 'element', elementId: 'a', x: 0, y: 0, extra: true },
      { version: 1, kind: 'element', elementId: 'a b', x: 0, y: 0 },
      { version: 1, kind: 'element', elementId: 'a', elementIds: ['b'], x: 0, y: 0 },
      { version: 1, kind: 'element', elementId: 'a', elementIds: ['a', 'a'], x: 0, y: 0 },
      { version: 1, kind: 'point', x: Number.MAX_VALUE, y: 0 },
    ]
    for (const anchor of invalid) expect(parseBoardAnchor(Buffer.from(JSON.stringify(anchor)))).toBeNull()
  })

  it('requires start/end to carry the same logical anchor', () => {
    const start = b64({ version: 1, kind: 'point', x: 0, y: 0 })
    const other = b64({ version: 1, kind: 'point', x: 1, y: 1 })
    const element = b64({ version: 1, kind: 'element', elementId: 'a', x: 0, y: 0 })
    expect(validateExplicitCommentAnchors('board', start, other)).toMatchObject({ ok: false, error: 'inconsistent_anchors' })
    expect(validateExplicitCommentAnchors('board', start, element)).toMatchObject({ ok: false, error: 'inconsistent_anchors' })
  })

  it('requires board format on boards and rejects it on doc/sheet/html', () => {
    const board = b64({ version: 1, kind: 'element', elementId: 'a', x: 0, y: 0 })
    const opaque = Buffer.from('existing opaque anchor').toString('base64')
    expect(validateExplicitCommentAnchors('board', opaque, opaque)).toMatchObject({ ok: false, error: 'board_anchor_required' })
    for (const type of ['doc', 'sheet', 'html'] as const) {
      expect(validateExplicitCommentAnchors(type, board, board)).toMatchObject({ ok: false, error: 'board_anchor_not_allowed' })
      expect(validateExplicitCommentAnchors(type, opaque, opaque).ok).toBe(true)
    }
  })
})
