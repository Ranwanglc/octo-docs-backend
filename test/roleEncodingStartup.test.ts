import { describe, expect, it, vi } from 'vitest'
import { requireCurrentRoleEncoding, type MetadataQuery } from '../src/db/roleEncoding.js'

function metadataQuery(rows: Array<{ metadata_value: unknown }>): MetadataQuery {
  return vi.fn(async () => rows) as MetadataQuery
}

describe('startup role-encoding gate', () => {
  it('accepts exactly one authoritative v2 marker', async () => {
    const query = metadataQuery([{ metadata_value: 'v2' }])
    await expect(requireCurrentRoleEncoding(query)).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledWith(
      'SELECT metadata_value FROM octo_schema_metadata WHERE metadata_key = ?',
      ['doc_role_encoding'],
    )
  })

  it.each([
    ['missing key', []],
    ['v1 marker', [{ metadata_value: 'v1' }]],
    ['unknown marker', [{ metadata_value: 'v3' }]],
  ])('rejects %s', async (_label, rows) => {
    await expect(requireCurrentRoleEncoding(metadataQuery(rows))).rejects.toThrow(
      /database doc role encoding must be v2/,
    )
  })

  it('rejects a missing metadata table or any database error', async () => {
    const cause = new Error('ER_NO_SUCH_TABLE')
    const query = vi.fn(async () => { throw cause }) as MetadataQuery
    await expect(requireCurrentRoleEncoding(query)).rejects.toThrow(/cannot verify/)
  })
})
