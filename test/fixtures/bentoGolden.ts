/**
 * SHARED golden CRDT convergence fixtures (XIN-1759 Part B / XIN-1764 Option 2,
 * Jeff constraint #2). ONE fixture set, generated deterministically from the
 * vendored Bento engine, consumable by BOTH the backend snapshotter tests and the
 * R4-F1 frontend — never copied per side. Each fixture is
 * `{ name, genesis, frames:[{q,frameId,ops}], expected:{doc,state}, snapshotAt }`,
 * where `frames` carry REAL Bento `Op`s minted by `SyncState.diff` (not hand-rolled
 * literals) and `expected` is the full-log reduction under the reserved reducer
 * actor. The consuming test asserts the convergence invariant: reducing the whole
 * log equals reducing a snapshot at `snapshotAt` then applying the tail.
 */
import { SyncState, type Op, type SyncStateJSON } from '../../src/ppt/sync/slidesSync.js'
import { reduceFrames, SNAPSHOT_REDUCER_ACTOR } from '../../src/ppt/relay/snapshotter.js'
import type { BentoDoc, BentoSlide } from '../../src/ppt/bentoDoc.js'

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** A minimal structurally-valid bento/slides genesis deck (one slide, one element). */
export function genesisDeck(): BentoDoc {
  return {
    format: 'bento/slides',
    version: 1,
    docId: 'golden-doc',
    title: 'Genesis',
    size: { width: 1280, height: 720 },
    theme: { background: '#ffffff', color: '#111111', accent: '#2563eb', fontFamily: 'Inter' },
    slides: [
      {
        id: 's1',
        background: '#ffffff',
        transition: 'none',
        notes: '',
        elements: [{ id: 'e1', html: '<p>hello world</p>' } as unknown as Record<string, unknown>],
      } as BentoSlide,
    ],
    modified: '2026-01-01T00:00:00.000Z',
  }
}

export interface GoldenFrame {
  q: number
  frameId: string
  ops: Op[]
}

export interface GoldenFixture {
  name: string
  genesis: BentoDoc
  frames: GoldenFrame[]
  expected: { doc: BentoDoc; state: SyncStateJSON }
  /** Frame index (1-based q) at which the snapshot-tail equivalence is checked. */
  snapshotAt: number
}

const el = (id: string, html: string): Record<string, unknown> => ({ id, html })

/**
 * Author a fixture by mutating a plain deck and letting the real engine mint the
 * ops for each step, so the fixture exercises genuine set/ins/ord/del/txt shapes.
 */
function authorFixture(name: string, steps: Array<(deck: BentoDoc) => void>, snapshotAt: number): GoldenFixture {
  const genesis = genesisDeck()
  const author = new SyncState('u-author')
  author.adopt(genesis)
  let prev = clone(genesis)
  const frames: GoldenFrame[] = []
  for (const mutate of steps) {
    const next = clone(prev)
    mutate(next)
    const ops = author.diff(prev, next, { text: true })
    prev = next
    // A step can be a no-op diff (nothing changed); skip empty op sets so every
    // persisted frame carries at least one op, matching the relay's contract.
    if (ops.length === 0) continue
    frames.push({ q: frames.length + 1, frameId: `${name}-f${frames.length + 1}`, ops })
  }
  const expected = reduceFrames(genesis, null, frames.map((f) => ({ seq: f.q, ops: f.ops })))
  return { name, genesis, frames, expected, snapshotAt: Math.min(snapshotAt, frames.length) }
}

/** Build the shared golden fixture set. Deterministic — no clocks / randomness. */
export function buildGoldenFixtures(): GoldenFixture[] {
  return [
    authorFixture(
      'set-lww-and-props',
      [
        (d) => { d.title = 'Renamed deck' },
        (d) => { (d.slides[0].elements[0] as Record<string, unknown>).x = 42 },
        (d) => { d.slides[0].background = '#000000' },
      ],
      1,
    ),
    authorFixture(
      'insert-slide-and-elements',
      [
        (d) => {
          d.slides.push({ id: 's2', background: '#eeeeee', transition: 'fade', notes: '', elements: [el('e2', '<p>second</p>')] } as BentoSlide)
        },
        (d) => { d.slides[0].elements.push(el('e3', '<p>third</p>')) },
        (d) => { (d.slides[1].elements[0] as Record<string, unknown>).color = 'red' },
      ],
      2,
    ),
    authorFixture(
      'reorder-and-delete',
      [
        (d) => {
          d.slides.push({ id: 's2', background: '#eee', transition: 'none', notes: '', elements: [el('e2', '<p>b</p>')] } as BentoSlide)
        },
        (d) => { d.slides.reverse() }, // reorder s2 before s1
        (d) => { d.slides[1].elements = [] }, // delete e1 from (now) s1
      ],
      1,
    ),
    authorFixture(
      'text-rga-edits',
      [
        (d) => { (d.slides[0].elements[0] as Record<string, unknown>).html = '<p>hello brave world</p>' },
        (d) => { (d.slides[0].elements[0] as Record<string, unknown>).html = '<p>hello brave new world</p>' },
        (d) => { (d.slides[0].elements[0] as Record<string, unknown>).html = '<p>hello new world</p>' },
      ],
      2,
    ),
  ]
}

export { reduceFrames, SNAPSHOT_REDUCER_ACTOR }
