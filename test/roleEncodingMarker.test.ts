import { describe, expect, it, vi } from 'vitest'
import {
  assertAppendV1RoleEncoding,
  ROLE_ENCODING_MARKER_ERROR,
  type RoleEncodingMarkerDb,
} from '../src/db/roleEncodingMarker.js'

function dbReturning(rows: Array<Record<string, unknown>>): RoleEncodingMarkerDb {
  return { query: vi.fn().mockResolvedValue(rows) }
}

describe('append-v1 role encoding startup guard', () => {
  it('accepts exactly one append-v1 marker', async () => {
    const db = dbReturning([{ meta_value: 'append-v1' }])

    await expect(assertAppendV1RoleEncoding(db)).resolves.toBeUndefined()
    expect(db.query).toHaveBeenCalledWith(
      'SELECT meta_value FROM docs_metadata WHERE meta_key = ?',
      ['role_encoding'],
    )
  })

  it.each([
    ['missing marker row', []],
    ['legacy ordered encoding', [{ meta_value: 'ordered' }]],
    ['v2 encoding', [{ meta_value: 'v2' }]],
    ['unknown encoding', [{ meta_value: 'append-v2' }]],
    ['non-string marker', [{ meta_value: null }]],
  ])('fails closed for %s', async (_label, rows) => {
    await expect(assertAppendV1RoleEncoding(dbReturning(rows))).rejects.toThrow(
      ROLE_ENCODING_MARKER_ERROR,
    )
  })

  it('fails closed when docs_metadata is absent or unreadable', async () => {
    const db: RoleEncodingMarkerDb = {
      query: vi.fn().mockRejectedValue(new Error("Table 'docs.docs_metadata' doesn't exist")),
    }

    await expect(assertAppendV1RoleEncoding(db)).rejects.toThrow(ROLE_ENCODING_MARKER_ERROR)
  })

  it('does not write or attempt to re-encode data', async () => {
    const db = dbReturning([{ meta_value: 'ordered' }])

    await expect(assertAppendV1RoleEncoding(db)).rejects.toThrow()
    expect(db.query).toHaveBeenCalledTimes(1)
    expect(vi.mocked(db.query).mock.calls[0]?.[0]).toMatch(/^SELECT /)
  })
})
