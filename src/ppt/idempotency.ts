/**
 * Canonical-payload helpers for the scoped `ppt_idempotency` store (§4.1).
 *
 * Idempotency semantics on the PPT create/register/publish endpoints:
 *   - Same `Idempotency-Key` header + same CANONICAL payload -> replay the
 *     original response, no new side effect.
 *   - Same key + a materially different canonical payload -> 409 CONFLICT.
 *
 * "Canonical" must be stable regardless of JSON key order or absent-vs-undefined
 * differences, so we serialize with recursively sorted object keys and hash the
 * result. Only the request fields that actually determine the created resource
 * feed the hash (for create: title, folderId, templateId) — transport-only
 * details (headers, unknown extra body fields) never shift the canonical form.
 */
import { createHash } from 'node:crypto'

/**
 * Deterministically serialize a JSON-ish value with object keys sorted at every
 * depth. Arrays keep their order (order is semantic); objects are key-sorted so
 * `{a,b}` and `{b,a}` collapse to the same string. `undefined` object values are
 * dropped (they are absent on the wire anyway).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(src).sort()) {
      if (src[key] === undefined) continue
      out[key] = sortValue(src[key])
    }
    return out
  }
  return value
}

/** SHA-256 (hex) of a value's canonical serialization. */
export function hashCanonicalPayload(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
