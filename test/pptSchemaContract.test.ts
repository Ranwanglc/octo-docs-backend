import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('PPT fresh schema contract', () => {
  it('ppt_collab_frame fresh-install DDL matches the runtime dedup contract', () => {
    const schema = readFileSync(resolve(process.cwd(), 'migrations/schema.sql'), 'utf8')
    const frameMatch = schema.match(/CREATE TABLE ppt_collab_frame \(([\s\S]*?)\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;/)
    expect(frameMatch).not.toBeNull()
    const frameDdl = frameMatch![1]!

    expect(frameDdl).toContain('payload_hash CHAR(64)')
    expect(frameDdl).toMatch(/frame_id\s+VARCHAR\(64\)\s+CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/)
    expect(frameDdl).toContain('PRIMARY KEY (doc_id, frame_id)')

    const opMatch = schema.match(/CREATE TABLE ppt_collab_op \(([\s\S]*?)\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;/)
    expect(opMatch).not.toBeNull()
    expect(opMatch![1]!).toMatch(/frame_id\s+VARCHAR\(64\)\s+CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/)
  })
})
