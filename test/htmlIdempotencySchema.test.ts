import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const schema = readFileSync(`${root}/migrations/schema.sql`, 'utf8')
const upgrade = readFileSync(`${root}/migrations/upgrades/2026-08-10-add-html-idempotency-key-hash.sql`, 'utf8')

describe('canonical HTML idempotency schema', () => {
  it('contains no alias schema and defines a binary SHA-256 mapping', () => {
    expect(schema.toLowerCase()).not.toContain(['html', 'alias'].join('_'))
    expect(schema).toMatch(/html_idempotency_key_hash\s+BINARY\(32\) NULL/)
    expect(schema).toContain('UNIQUE KEY uk_html_idempotency (space_id, owner_id, html_idempotency_key_hash, doc_type)')
  })

  it('guards both upgrade operations for at-least-once execution', () => {
    expect(upgrade).toContain("column_name = 'html_idempotency_key_hash'")
    expect(upgrade).toContain("index_name = 'uk_html_idempotency'")
    expect(upgrade.match(/IF NOT EXISTS/g)).toHaveLength(2)
    expect(upgrade).toContain('BINARY(32) NULL')
  })
})
