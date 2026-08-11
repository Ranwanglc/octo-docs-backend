/**
 * MySQL connection pool (§3.4 / §3.2).
 *
 * The authoritative store is MySQL. This module exposes a shared mysql2 pool
 * plus thin `query` / `transaction` helpers used by the repos and by the
 * persistence adapter's read-modify-write path (§3.2 SELECT ... FOR UPDATE).
 */
import mysql from 'mysql2/promise'
import { config } from '../config/env.js'

export type Row = Record<string, unknown>

let pool: mysql.Pool | null = null

export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.database,
      connectionLimit: config.mysql.connectionLimit,
      waitForConnections: true,
      // Keep binary columns (LONGBLOB state) as Buffer, not string.
      // mysql2 returns BLOB/LONGBLOB as Buffer by default.
      namedPlaceholders: false,
    })
  }
  return pool
}

/** Execute a query against the pool, returning the result rows. */
export async function query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await getPool().execute(sql, params as never[])
  return rows as T[]
}

export interface Tx {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number }>
}

/**
 * Run `fn` inside a single transaction on a dedicated connection.
 * Commits on success, rolls back on any thrown error (§3.2 store).
 */
export async function transaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R> {
  const conn = await getPool().getConnection()
  try {
    await conn.beginTransaction()
    const tx: Tx = {
      async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
        const [rows] = await conn.execute(sql, params as never[])
        return rows as T[]
      },
      async execute(sql: string, params: unknown[] = []): Promise<{ affectedRows: number }> {
        const [result] = await conn.execute(sql, params as never[])
        return result as { affectedRows: number }
      },
    }
    const result = await fn(tx)
    await conn.commit()
    return result
  } catch (err) {
    try {
      await conn.rollback()
    } catch {
      /* ignore rollback failure; surface the original error */
    }
    throw err
  } finally {
    conn.release()
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
