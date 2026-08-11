/**
 * Canonical browser-facing URL for an ordinary document.
 *
 * Phase 1 removes Space from the locator: every caller (web, bot, CLI, plugin)
 * emits exactly `<web-origin>/d/<docId>`. The optional legacy `spaceId`
 * argument is intentionally ignored so existing integrations can upgrade
 * without continuing to mint `sp` links. This is type-agnostic: ordinary docs
 * AND PPT decks share the same bare `/d/:docId` link. On open, open-context
 * resolves the canonical home Space. The separate PPT editor transport URL may
 * retain `sp` during its compatibility window; it is not a share URL.
 */
export function buildDocShareUrl(webOrigin: string, docId: string, _spaceId?: string): string {
  const origin = webOrigin.trim().replace(/\/+$/, '')
  return `${origin}/d/${encodeURIComponent(docId)}`
}

/**
 * Legacy editor-transport URL for a PPT (`html_ppt`) deck — the route a freshly created
 * deck should open in for editing. Mirrors {@link buildDocShareUrl}'s origin
 * handling and retains `?sp=<spaceId>` compatibility, but carries an explicit `/edit` intent so
 * the frontend routes the deck into the PPT editor (not the read-only preview).
 * Degrades to an origin-relative path when `webOrigin` is empty, exactly like the
 * share link. Do not use this builder for `shareUrl`: PPT share links are bare
 * `/d/:docId` and resolve their canonical home Space through open-context.
 */
export function buildPptEditorUrl(webOrigin: string, docId: string, spaceId?: string): string {
  const origin = webOrigin.trim().replace(/\/+$/, '')
  const path = `${origin}/d/${encodeURIComponent(docId)}/edit`
  return spaceId ? `${path}?sp=${encodeURIComponent(spaceId)}` : path
}
