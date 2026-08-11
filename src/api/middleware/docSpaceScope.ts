/**
 * Document space-scoping policy (remove-sp §6 / §6.1).
 *
 * Phase-1 removes the `sp` URL dependency by making Human single-document
 * requests locate the doc by its path `docId` ALONE — the client-supplied
 * `X-Space-Id` header must not influence document selection or the authorization
 * result. Bot requests keep the current server-resolved-Space + `requireSameSpace`
 * semantics unchanged.
 *
 * The boundary between the two principals is made EXPLICIT here, set once per
 * mount, and read by the shared guards. The design forbids inferring it from
 * `req.botToken !== undefined` inside shared logic (that silently changes the
 * security boundary): the mount that installs the identity also declares the
 * scope, and the guard branches on `req.docSpaceScope.mode`.
 *
 *   - Human DocumentResourceRouter → { mode: 'human' }: locate by docId, ignore
 *     `X-Space-Id` for selection/authz. The header is still parsed OPTIONALLY
 *     into `req.viewerSpaceId` for the verified-or-skip recent-view write
 *     (remove-sp §7.1) — never for doc selection.
 *   - Bot mount → { mode: 'bot', spaceId }: the server-resolved Space
 *     (verifyBot reverse lookup). The guard enforces `requireSameSpace` against
 *     it, exactly as before.
 */
import type { Request, Response, NextFunction } from 'express'

export type DocSpaceScope =
  | { mode: 'human' }
  | { mode: 'bot'; spaceId: string }

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Explicit per-mount doc space-scoping policy (remove-sp §6). Set by
       * {@link humanDocSpaceScopeMiddleware} (human) or verifyBot (bot). Read by
       * requireDocRole and the access-request submit handler to decide whether a
       * cross-space hit is a 404 (bot) or an ordinary docId locate (human).
       */
      docSpaceScope?: DocSpaceScope
      /**
       * Human only: the OPTIONAL, UNVERIFIED viewer Space from `X-Space-Id`,
       * trimmed. Used solely by the verified-or-skip recent-view write — the
       * write lands only after the caller's active membership of THIS Space is
       * confirmed (remove-sp §7.1). Never used for document selection/authz.
       */
      viewerSpaceId?: string
    }
  }
}

/**
 * Install the Human open-context doc scope (remove-sp §6). Mounted on the Human
 * DocumentResourceRouter AFTER authMiddleware and BEFORE the single-document
 * routers. Does NOT require `X-Space-Id` (no 400) — a missing header is normal
 * for a `/d/:docId` open. Parses the header optionally for the recent-view write.
 */
export function humanDocSpaceScopeMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.docSpaceScope = { mode: 'human' }
  const raw = req.header('X-Space-Id')
  const viewer = typeof raw === 'string' ? raw.trim() : ''
  if (viewer !== '') req.viewerSpaceId = viewer
  next()
}
