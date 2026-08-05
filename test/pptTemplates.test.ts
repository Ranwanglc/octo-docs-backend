import { describe, it, expect } from 'vitest'
import {
  PPT_TEMPLATE_IDS,
  PPT_TEMPLATE_SUMMARIES,
  isPptTemplateId,
  getPptTemplate,
} from '../src/ppt/templates.js'
import { instantiateTemplate, isBentoDoc, BENTO_FORMAT, BENTO_FORMAT_VERSION } from '../src/ppt/bentoDoc.js'

// PPT-UI-001 (backend portion) + R2-B1 "four fixed templates only".
// The frontend keyboard/preview UX is proven in octo-web; here we prove the
// backend guarantees the picker relies on: EXACTLY four fixed 16:9 templates,
// and every materialized deck has a fresh docId/collab identity and no template
// marker.
describe('bundled PPT templates — the fixed four (D6)', () => {
  it('exposes exactly four template ids, no admin-extensible registry', () => {
    expect(PPT_TEMPLATE_IDS).toHaveLength(4)
    expect([...PPT_TEMPLATE_IDS]).toEqual(['blank', 'pitch', 'report', 'lesson'])
    // Summaries (id/name/scenario the picker renders) cover exactly those ids.
    expect(PPT_TEMPLATE_SUMMARIES.map((t) => t.id)).toEqual([...PPT_TEMPLATE_IDS])
    for (const s of PPT_TEMPLATE_SUMMARIES) {
      expect(s.name).toBeTruthy()
      expect(s.scenario).toBeTruthy()
    }
  })

  it('accepts only the four ids (isPptTemplateId)', () => {
    for (const id of PPT_TEMPLATE_IDS) expect(isPptTemplateId(id)).toBe(true)
    for (const bad of ['', 'BLANK', 'deck', 'custom', 'toString', '__proto__', 42, null, undefined]) {
      expect(isPptTemplateId(bad as unknown)).toBe(false)
    }
  })

  it('every bundled template is a valid 16:9 bento/slides deck carrying template + collab markers', () => {
    for (const id of PPT_TEMPLATE_IDS) {
      const t = getPptTemplate(id)!
      expect(t).not.toBeNull()
      expect(isBentoDoc(t)).toBe(true)
      expect(t.format).toBe(BENTO_FORMAT)
      expect(t.version).toBe(BENTO_FORMAT_VERSION)
      expect(t.size).toEqual({ width: 1280, height: 720 })
      // The source file is a template with live-collab markers, so that
      // instantiation is provably exercised (both get stripped below).
      expect(t.template).toBe(true)
      expect(t.collab).toBeDefined()
      expect(t.slides.length).toBeGreaterThan(0)
    }
  })

  it('returns null for an unknown id', () => {
    expect(getPptTemplate('nope')).toBeNull()
  })
})

describe('instantiateTemplate — Bento parseDoc parity (strip template, fresh docId, drop collab)', () => {
  it('strips the template marker, mints a fresh docId, and drops collab for every template', () => {
    for (const id of PPT_TEMPLATE_IDS) {
      const source = getPptTemplate(id)!
      const deck = instantiateTemplate(source, '2026-08-05T00:00:00.000Z')
      expect(deck.template).toBeUndefined()
      expect(deck.collab).toBeUndefined()
      expect(deck.docId).not.toBe(source.docId)
      expect(deck.docId).toMatch(/[0-9a-f-]{36}/) // fresh uuid identity
      expect(deck.format).toBe(BENTO_FORMAT)
      expect(deck.version).toBe(BENTO_FORMAT_VERSION)
      expect(deck.modified).toBe('2026-08-05T00:00:00.000Z')
      expect(deck.slides).toEqual(source.slides) // content preserved
    }
  })

  it('mints a distinct docId on every instantiation (each open is a new document)', () => {
    const source = getPptTemplate('pitch')!
    const a = instantiateTemplate(source, '2026-08-05T00:00:00.000Z')
    const b = instantiateTemplate(source, '2026-08-05T00:00:00.000Z')
    expect(a.docId).not.toBe(b.docId)
  })

  it('does not mutate the shared source template (deep clone)', () => {
    const source = getPptTemplate('report')!
    const beforeDocId = source.docId
    instantiateTemplate(source, '2026-08-05T00:00:00.000Z')
    expect(source.template).toBe(true)
    expect(source.collab).toBeDefined()
    expect(source.docId).toBe(beforeDocId)
  })

  it('rejects a non-bento source', () => {
    expect(() => instantiateTemplate({ format: 'x', slides: [] } as never, 'now')).toThrow()
  })
})
