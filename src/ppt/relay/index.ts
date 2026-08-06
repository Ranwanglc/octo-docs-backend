/**
 * Production wiring for the PPT relay (R4-B1).
 *
 * Composes the relay's default dependencies: the MySQL-backed durable store, the
 * authoritative permission-epoch reader (Redis cache -> DB fallback), a role
 * re-resolver for downgrade enforcement, and the doc-liveness guard. The relay
 * itself is transport-agnostic; {@link PptRelay.attach} binds it to B's existing
 * REST HTTP server on the `/api/v1/ppt/collab` upgrade path — no second service.
 */
import { PptRelay } from './pptRelay.js'
import { DbPptRelayStore } from './dbStore.js'
import { currentEpoch } from '../../permission/epoch.js'
import { resolveRole } from '../../permission/resolveRole.js'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'

/** Build the production relay wired to DB/Redis-backed dependencies. */
export function createPptRelay(): PptRelay {
  return new PptRelay({
    store: new DbPptRelayStore(),
    epochProvider: (documentName) => currentEpoch(documentName),
    // Downgrade enforcement re-resolves the DIRECT authoritative role (owner /
    // member row); a removed member resolves to 'none' and the socket is closed.
    roleProvider: (uid, docId) => resolveRole(uid, docId),
    docStatusProvider: async (docId) => {
      const meta = await docMetaRepo.getByDocId(docId)
      return meta && meta.status !== 0 ? 'live' : 'deleted'
    },
  })
}
