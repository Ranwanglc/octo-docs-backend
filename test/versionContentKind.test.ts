import { describe, it, expect } from 'vitest'
import { DOC_TYPES } from '../src/db/docType.js'
import { contentKindFromDocType, type VersionContentKind } from '../src/collab/versionRestore.js'

// R1-B1 (§1.3): contentKindFromDocType is the discriminator that routes a doc's
// version blob to the correct decoder. It MUST be an exhaustive allowlist over
// DOC_TYPES so html_ppt (a BentoDoc blob) can never silently inherit the Yjs /
// ProseMirror `document` decode path. The compile-time `never` guard lives in the
// source; these tests pin the runtime mapping for every wire kind.
describe('contentKindFromDocType — exhaustive allowlist over DOC_TYPES', () => {
  const expected: Record<(typeof DOC_TYPES)[number], VersionContentKind> = {
    doc: 'document',
    sheet: 'document',
    board: 'board',
    html: 'document',
    html_ppt: 'ppt',
  }

  it('maps every DOC_TYPES member to a defined content kind', () => {
    for (const t of DOC_TYPES) {
      expect(contentKindFromDocType(t)).toBe(expected[t])
    }
  })

  it('every DOC_TYPES member resolves (no undefined fall-through)', () => {
    for (const t of DOC_TYPES) {
      expect(['document', 'board', 'ppt']).toContain(contentKindFromDocType(t))
    }
  })

  it('routes html_ppt to the decode-less "ppt" line (never "document")', () => {
    expect(contentKindFromDocType('html_ppt')).toBe('ppt')
    expect(contentKindFromDocType('html_ppt')).not.toBe('document')
  })

  it('keeps board on its own line and doc/sheet/html on the document line', () => {
    expect(contentKindFromDocType('board')).toBe('board')
    expect(contentKindFromDocType('doc')).toBe('document')
    expect(contentKindFromDocType('sheet')).toBe('document')
    expect(contentKindFromDocType('html')).toBe('document')
  })

  it('falls back to the document line for an unknown/legacy doc_type (runtime-safe)', () => {
    // The `never` guard is a BUILD-time contract; at runtime a value outside
    // DOC_TYPES must not throw — it maps to the historical document line.
    expect(contentKindFromDocType('legacy_kind')).toBe('document')
    expect(contentKindFromDocType('')).toBe('document')
  })
})
