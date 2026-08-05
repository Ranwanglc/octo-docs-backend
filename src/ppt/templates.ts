/**
 * The four bundled PPT templates (v1, FIXED set — no admin-extensible registry).
 *
 * Gate3 decision D6 (XIN-1493 §1.2): v1 ships exactly four bundled 16:9 decks;
 * there is NO admin template CRUD. `POST /api/v1/ppt/docs` materializes exactly
 * one of these by `templateId`; any other id is a 400 VALIDATION_ERROR.
 *
 * Each template is authored as a bento/slides deck carrying the `template`
 * marker AND a `collab` block, so materialization (see instantiateTemplate) is
 * provably exercised: the marker is stripped, a fresh docId is minted, and the
 * collab block is dropped for every created deck. The template objects here are
 * the SHARED source of truth and must never be mutated — `getPptTemplate`
 * returns them by reference for reads and `instantiateTemplate` deep-clones
 * before stripping.
 */
import {
  BENTO_FORMAT,
  BENTO_FORMAT_VERSION,
  type BentoDoc,
} from './bentoDoc.js'

/** 16:9 slide coordinate space shared by every bundled template. */
const SIZE_16_9 = { width: 1280, height: 720 } as const

const FONT_STACK =
  "'Inter', 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', Arial, sans-serif"

/** A caller-facing template card (id + display name + scenario blurb). */
export interface PptTemplateSummary {
  id: string
  name: string
  scenario: string
}

/**
 * A placeholder live-collab block. Its ONLY purpose is to prove that
 * instantiation drops `collab`: a materialized deck must never carry these
 * credentials. Values are inert placeholders, never real relay keys.
 */
const TEMPLATE_COLLAB = { room: 'template-room-placeholder', key: 'template-key-placeholder', on: false }

function text(id: string, value: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'text', text: value, ...extra }
}

/**
 * Build one bundled template deck. `template: true` + a `collab` block are
 * always present so every materialization strips them.
 */
function template(id: string, title: string, slides: BentoDoc['slides'], accent: string): BentoDoc {
  return {
    format: BENTO_FORMAT,
    version: BENTO_FORMAT_VERSION,
    // A stable authoring-time id; instantiation always replaces it with a fresh
    // uuid, so this value never reaches a created document.
    docId: `template_${id}`,
    title,
    size: { ...SIZE_16_9 },
    theme: {
      background: '#FFFFFF',
      color: '#1E2A3A',
      accent,
      fontFamily: FONT_STACK,
    },
    template: true,
    collab: { ...TEMPLATE_COLLAB },
    slides,
    modified: '1970-01-01T00:00:00.000Z',
  }
}

function slide(id: string, elements: unknown[], name: string): BentoDoc['slides'][number] {
  return { id, background: '#FFFFFF', transition: 'fade', elements, notes: '', name }
}

/**
 * The FIXED four. Order here is the order the picker shows them. Ids are the
 * wire `templateId` values the create endpoint accepts.
 */
const TEMPLATES: Record<string, BentoDoc> = {
  blank: template(
    'blank',
    'Blank',
    [slide('s_blank_1', [text('e_title', 'Title')], 'Title')],
    '#F7A600',
  ),
  pitch: template(
    'pitch',
    'Pitch',
    [
      slide('s_pitch_cover', [text('e_title', 'Company Name'), text('e_sub', 'One-line pitch')], 'Cover'),
      slide('s_pitch_problem', [text('e_title', 'Problem'), text('e_body', 'What hurts today')], 'Problem'),
      slide('s_pitch_solution', [text('e_title', 'Solution'), text('e_body', 'How we fix it')], 'Solution'),
    ],
    '#2F6BFF',
  ),
  report: template(
    'report',
    'Report',
    [
      slide('s_report_cover', [text('e_title', 'Quarterly Report'), text('e_sub', 'Q_ · Team')], 'Cover'),
      slide('s_report_metrics', [text('e_title', 'Key Metrics'), text('e_body', 'Highlights')], 'Metrics'),
    ],
    '#0FA958',
  ),
  lesson: template(
    'lesson',
    'Lesson',
    [
      slide('s_lesson_cover', [text('e_title', 'Lesson Title'), text('e_sub', 'Course · Unit')], 'Cover'),
      slide('s_lesson_objectives', [text('e_title', 'Objectives'), text('e_body', 'What you will learn')], 'Objectives'),
      slide('s_lesson_summary', [text('e_title', 'Summary')], 'Summary'),
    ],
    '#8B5CF6',
  ),
}

/** The fixed template ids, in picker order. */
export const PPT_TEMPLATE_IDS: readonly string[] = ['blank', 'pitch', 'report', 'lesson']

/** Caller-facing summaries (id + name + scenario), in picker order. */
export const PPT_TEMPLATE_SUMMARIES: readonly PptTemplateSummary[] = [
  { id: 'blank', name: 'Blank', scenario: 'Start from an empty 16:9 deck' },
  { id: 'pitch', name: 'Pitch', scenario: 'Startup / product pitch deck' },
  { id: 'report', name: 'Report', scenario: 'Quarterly business review' },
  { id: 'lesson', name: 'Lesson', scenario: 'Teaching / training slides' },
]

/** True when `v` is one of the four fixed template ids. */
export function isPptTemplateId(v: unknown): v is string {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(TEMPLATES, v) && PPT_TEMPLATE_IDS.includes(v)
}

/**
 * Return the SHARED template source for `id` (by reference — callers must not
 * mutate it; `instantiateTemplate` clones before stripping). Returns null for an
 * unknown id so the caller can map that to 400 VALIDATION_ERROR.
 */
export function getPptTemplate(id: string): BentoDoc | null {
  return isPptTemplateId(id) ? TEMPLATES[id]! : null
}
