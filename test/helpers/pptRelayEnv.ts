/**
 * Test-only env seeding for the PPT relay/collab-token tests. Imported FIRST
 * (before any module that reads config/env.ts) so the collab-token public WS
 * origin is populated when the config object is frozen at load. `??=` so an
 * explicit outer env still wins.
 */
process.env.PPT_RELAY_PUBLIC_WS_URL ??= 'ws://ppt-relay.example.test'
process.env.OCTO_WEB_ORIGIN ??= 'https://ppt-web.example.test'
process.env.CORS_ALLOWED_ORIGINS ??= 'https://ppt-web.example.test'
