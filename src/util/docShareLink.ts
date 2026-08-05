/**
 * Canonical doc share-link builder.
 *
 * This is the SINGLE place the backend mints the browser-facing URL a caller
 * (a bot via octo-cli, the OpenClaw octo plugin, or any integration) can pass
 * straight through to chat. It mirrors octo-web's authoritative `buildDocLink`
 * (packages/docs/src/forward/link.ts) byte-for-byte for the same (docId,
 * spaceId), so a link minted here and one minted by a human's "forward to chat"
 * are identical.
 *
 * Canonical format:
 *   <web-origin>/d/<docId>?sp=<spaceId>
 *
 *   - The path carries the docId (NOT a `/docs?doc=` query — the octo host's
 *     RouteManager strips the query, which is what produced the broken links).
 *   - `?sp=<spaceId>` is the doc's real space id so the recipient's
 *     `GET /docs/{docId}` preflight addresses the doc's own space. Omitted when
 *     no spaceId is available.
 *   - NEVER emit `?sid`.
 *
 * When `webOrigin` is empty the URL degrades to a path-only, origin-relative
 * form (`/d/<docId>?sp=<spaceId>`) — mirroring octo-web's origin()-empty
 * degrade — rather than baking in a wrong absolute host.
 */
export function buildDocShareUrl(webOrigin: string, docId: string, spaceId?: string): string {
  const origin = webOrigin.trim().replace(/\/+$/, '')
  const path = `${origin}/d/${encodeURIComponent(docId)}`
  return spaceId ? `${path}?sp=${encodeURIComponent(spaceId)}` : path
}

/**
 * Editor-facing URL for a PPT (`html_ppt`) deck — the route a freshly created
 * deck should open in for editing. Mirrors {@link buildDocShareUrl}'s origin
 * handling and `?sp=<spaceId>` scoping, but carries an explicit `/edit` intent so
 * the frontend routes the deck into the PPT editor (not the read-only preview).
 * Degrades to an origin-relative path when `webOrigin` is empty, exactly like the
 * share link.
 */
export function buildPptEditorUrl(webOrigin: string, docId: string, spaceId?: string): string {
  const origin = webOrigin.trim().replace(/\/+$/, '')
  const path = `${origin}/d/${encodeURIComponent(docId)}/edit`
  return spaceId ? `${path}?sp=${encodeURIComponent(spaceId)}` : path
}
