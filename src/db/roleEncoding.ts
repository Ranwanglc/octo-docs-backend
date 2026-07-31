import { query } from './pool.js'

const ROLE_ENCODING_KEY = 'doc_role_encoding'
const REQUIRED_ROLE_ENCODING = 'v2'

interface MetadataRow {
  metadata_value: unknown
}

export type MetadataQuery = <T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>

/** Fail startup unless the database explicitly records the role encoding this binary uses. */
export async function requireCurrentRoleEncoding(dbQuery: MetadataQuery = query): Promise<void> {
  let rows: MetadataRow[]
  try {
    rows = await dbQuery<MetadataRow>(
      'SELECT metadata_value FROM octo_schema_metadata WHERE metadata_key = ?',
      [ROLE_ENCODING_KEY],
    )
  } catch (cause) {
    throw new Error('cannot verify database doc role encoding', { cause })
  }

  if (rows.length !== 1 || rows[0]?.metadata_value !== REQUIRED_ROLE_ENCODING) {
    const actual = rows.length === 0 ? 'missing' : String(rows[0]?.metadata_value)
    throw new Error(`database doc role encoding must be v2 (found ${actual})`)
  }
}
