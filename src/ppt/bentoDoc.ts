/**
 * Minimal Bento `bento/slides` document model + template instantiation, ported
 * to the backend so PPT create can materialize a fresh deck WITHOUT taking a
 * runtime dependency on the Bento editor package.
 *
 * The shape mirrors Bento's own `BentoDoc` (nyblnet/bento slides/src/model.ts):
 * `format = 'bento/slides'`, `version = FORMAT_VERSION (1)`, a stable per-document
 * `docId`, `title`, `size`, `theme`, `slides[]`, and `modified`. Only the fields
 * the backend needs to persist/serve a starter deck are typed here; unknown
 * fields on a real deck (assets, fonts, present chrome, …) round-trip untouched
 * via the index signature.
 *
 * Template instantiation reproduces Bento's `parseDoc` open-a-template semantics
 * EXACTLY (slides/src/model.ts): when a doc carries the `template` marker, opening
 * it "is a new document" — strip `template`, mint a fresh `docId`, and drop the
 * `collab` block so each materialized deck gets its own identity and never
 * inherits the template file's live-collab credentials.
 */
import { randomUUID } from 'node:crypto'

/** Bento deck format tag — the discriminator inside the deck JSON. */
export const BENTO_FORMAT = 'bento/slides'
/** Bento deck format version this backend mints/accepts (Bento `FORMAT_VERSION`). */
export const BENTO_FORMAT_VERSION = 1
/** Bento CRDT sync protocol version (`SYNC_V`) stamped on live frames/state. */
export const BENTO_SYNC_V = 2

/** A single slide (subset of Bento's `Slide`). */
export interface BentoSlide {
  id: string
  background: string
  transition: string
  elements: unknown[]
  notes: string
  name?: string
  [k: string]: unknown
}

/**
 * A bento/slides document (subset of Bento's `BentoDoc`). The index signature
 * preserves any additional Bento fields (assets/fonts/present/…) on round-trip.
 */
export interface BentoDoc {
  format: typeof BENTO_FORMAT
  version: number
  docId: string
  title: string
  size: { width: number; height: number }
  theme: {
    background: string
    color: string
    accent: string
    fontFamily: string
    [k: string]: unknown
  }
  slides: BentoSlide[]
  modified: string
  /** Present ONLY on a template file; stripped the moment it is instantiated. */
  template?: boolean
  /** Live-collab credentials on a template; dropped on instantiation. */
  collab?: unknown
  [k: string]: unknown
}

/** Mint a fresh per-document identity (uuid), matching Bento's `newDocId()`. */
export function newBentoDocId(): string {
  return randomUUID()
}

/**
 * Structural guard: a value is a usable bento/slides deck when it has the right
 * `format` and a non-empty `slides` array. Mirrors the acceptance gate in
 * Bento's `parseDoc` (`doc.format === FORMAT && Array.isArray(slides) && length>0`).
 */
export function isBentoDoc(v: unknown): v is BentoDoc {
  if (!v || typeof v !== 'object') return false
  const d = v as Record<string, unknown>
  return d.format === BENTO_FORMAT && Array.isArray(d.slides) && d.slides.length > 0
}

/**
 * Instantiate a template deck into a fresh, independent document.
 *
 * Reproduces Bento `parseDoc`'s template branch verbatim: every open of a
 * template "is a new document", so we
 *   1. deep-clone the template (never mutate the shared source),
 *   2. delete the `template` marker,
 *   3. mint a brand-new `docId`, and
 *   4. drop the `collab` block (the new deck must not inherit the template's
 *      live-collab room/keys).
 *
 * The clone is also normalized to the backend's minted `version`/`modified`
 * stamp. Throws if the source is not a structurally valid bento/slides deck.
 */
export function instantiateTemplate(template: BentoDoc, now: string): BentoDoc {
  if (!isBentoDoc(template)) {
    throw new Error('template is not a valid bento/slides document')
  }
  const doc = JSON.parse(JSON.stringify(template)) as BentoDoc
  // template instantiation: this open IS a new document (Bento parseDoc parity).
  delete doc.template
  doc.docId = newBentoDocId()
  delete doc.collab
  doc.version = BENTO_FORMAT_VERSION
  doc.modified = now
  return doc
}
