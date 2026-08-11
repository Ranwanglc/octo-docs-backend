import { describe, it, expect } from 'vitest'
import { buildDocShareUrl } from '../src/util/docShareLink.js'

// Every backend-produced share link mirrors the no-Space web locator:
// `<web-origin>/d/<docId>`, for ordinary docs and PPT decks alike. A legacy
// space argument must not reintroduce either `sp` or `sid`; the PPT editor
// transport has a separate compatibility builder and is not a share link.

describe('buildDocShareUrl (canonical doc share link)', () => {
  const WEB = 'http://192.168.214.189:3010'

  it('builds <origin>/d/<docId> and ignores a legacy space argument', () => {
    expect(buildDocShareUrl(WEB, 'd_abc123', 's_space1')).toBe(
      'http://192.168.214.189:3010/d/d_abc123',
    )
  })

  it('uses the same no-Space locator when no space is given', () => {
    expect(buildDocShareUrl(WEB, 'd_abc123')).toBe('http://192.168.214.189:3010/d/d_abc123')
    expect(buildDocShareUrl(WEB, 'd_abc123', '')).toBe('http://192.168.214.189:3010/d/d_abc123')
  })

  it('URL-encodes the docId but never serializes the legacy space argument', () => {
    expect(buildDocShareUrl(WEB, 'd_a b/c', 's p&x')).toBe(
      'http://192.168.214.189:3010/d/d_a%20b%2Fc',
    )
  })

  it('degrades to an origin-relative path-only form when webOrigin is empty', () => {
    expect(buildDocShareUrl('', 'd_abc123', 's_space1')).toBe('/d/d_abc123')
    expect(buildDocShareUrl('   ', 'd_abc123', 's_space1')).toBe('/d/d_abc123')
    expect(buildDocShareUrl('', 'd_abc123')).toBe('/d/d_abc123')
  })

  it('strips a trailing slash on the origin so the path is not doubled', () => {
    expect(buildDocShareUrl('http://web.example.com/', 'd_abc123', 's_space1')).toBe(
      'http://web.example.com/d/d_abc123',
    )
    expect(buildDocShareUrl('http://web.example.com///', 'd_abc123')).toBe(
      'http://web.example.com/d/d_abc123',
    )
  })

  it('never emits either Space query key', () => {
    for (const url of [
      buildDocShareUrl(WEB, 'd_abc123', 's_space1'),
      buildDocShareUrl(WEB, 'd_abc123'),
      buildDocShareUrl('', 'd_abc123', 's_space1'),
    ]) {
      expect(url).not.toContain('sp=')
      expect(url).not.toContain('sid=')
    }
  })

  it('uses the same bare canonical share link for an html_ppt docId', () => {
    expect(buildDocShareUrl(WEB, 'd_ppt789', 's_home')).toBe(
      'http://192.168.214.189:3010/d/d_ppt789',
    )
  })
})
