/**
 * Runtime compatibility guard for persisted role numbers.
 *
 * The application interprets role values as append-v1 (reader=1, writer=2,
 * admin=3, commenter=4). Starting against any other or unmarked schema could
 * silently grant the wrong permissions, so verification is deliberately
 * read-only and fail-closed. Operators must run the migration; this code never
 * rewrites marker or role data.
 */

export const EXPECTED_ROLE_ENCODING = 'append-v1'
export const ROLE_ENCODING_MARKER_ERROR =
  'Incompatible role encoding: docs_metadata.role_encoding must equal append-v1; run the database migrations before starting the service'

export interface RoleEncodingMarkerDb {
  query(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>
}

export async function assertAppendV1RoleEncoding(db: RoleEncodingMarkerDb): Promise<void> {
  try {
    const rows = await db.query('SELECT meta_value FROM docs_metadata WHERE meta_key = ?', [
      'role_encoding',
    ])
    if (rows.length !== 1 || rows[0]?.meta_value !== EXPECTED_ROLE_ENCODING) {
      throw new Error(ROLE_ENCODING_MARKER_ERROR)
    }
  } catch (cause) {
    if (cause instanceof Error && cause.message === ROLE_ENCODING_MARKER_ERROR) throw cause
    throw new Error(ROLE_ENCODING_MARKER_ERROR, { cause })
  }
}
