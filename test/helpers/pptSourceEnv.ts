/**
 * Test-only env seeding for the PPT source route tests. Imported FIRST (before
 * any module that reads config/env.ts) so `config.cors.allowedOrigins` and
 * `config.webOrigin` are populated when the config object is frozen at load.
 * Uses `??=` so an explicit outer env still wins.
 */
process.env.OCTO_WEB_ORIGIN ??= 'https://ppt-web.example.test'
process.env.CORS_ALLOWED_ORIGINS ??= 'https://ppt-web.example.test'
