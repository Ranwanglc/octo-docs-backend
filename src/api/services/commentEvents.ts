import { getRedis, rkey } from '../../db/redis.js'
import { getCollabServer } from '../../collab/server.js'
import { parseDocumentName } from '../../permission/documentName.js'

export type CommentAction = 'created' | 'updated' | 'deleted'

/** Internal Redis envelope; documentName is routing-only and never sent to clients. */
interface CommentMutationEvent {
  type: 'comment.changed'
  documentName: string
  docId: string
  commentId?: number
  action: CommentAction
}

export function commentEventsChannel(): string {
  return rkey('comment-events')
}

/** Publish only invalidation metadata; comment bodies and anchors remain in MySQL. */
export async function publishCommentMutation(
  documentName: string,
  docId: string,
  commentId: number | undefined,
  action: CommentAction,
): Promise<void> {
  const event: CommentMutationEvent = {
    type: 'comment.changed',
    documentName,
    docId,
    ...(commentId === undefined ? {} : { commentId }),
    action,
  }
  try {
    await getRedis().publish(commentEventsChannel(), JSON.stringify(event))
  } catch {
    // Real-time invalidation is best-effort; the REST mutation already committed.
  }
}

/** Broadcast through Hocuspocus stateless to authenticated connections of this document only. */
export function broadcastCommentMutation(message: string): void {
  let event: CommentMutationEvent
  try {
    event = JSON.parse(message) as CommentMutationEvent
  } catch {
    return
  }
  if (
    event?.type !== 'comment.changed' ||
    typeof event.documentName !== 'string' ||
    typeof event.docId !== 'string' || event.docId.length === 0 ||
    (event.commentId !== undefined && (!Number.isSafeInteger(event.commentId) || event.commentId <= 0)) ||
    !(['created', 'updated', 'deleted'] as unknown[]).includes(event.action)
  ) return

  // Redis is an internal boundary, not an authorization boundary. Refuse to
  // route an event unless its redundant doc id agrees with the canonical
  // document name; malformed or mismatched envelopes default to no broadcast.
  try {
    const parsed = parseDocumentName(event.documentName)
    const routedId = parsed.kind === 'whiteboard' ? parsed.board : parsed.doc
    if (routedId !== event.docId) return
  } catch {
    return
  }

  const server = getCollabServer()
  const document = server.hocuspocus.documents.get(event.documentName)
  if (!document) return
  const wireEvent = {
    type: event.type,
    docId: event.docId,
    ...(event.commentId === undefined ? {} : { commentId: event.commentId }),
    action: event.action,
  }
  document.broadcastStateless(JSON.stringify(wireEvent))
}
