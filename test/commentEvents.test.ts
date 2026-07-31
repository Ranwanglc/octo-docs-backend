import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/db/redis.js', () => ({
  rkey: (...parts: string[]) => ['octo', ...parts].join(':'),
  getRedis: vi.fn(),
}))
vi.mock('../src/collab/server.js', () => ({ getCollabServer: vi.fn() }))

import { getRedis } from '../src/db/redis.js'
import { getCollabServer } from '../src/collab/server.js'
import {
  broadcastCommentMutation,
  commentEventsChannel,
  publishCommentMutation,
} from '../src/api/services/commentEvents.js'

beforeEach(() => vi.clearAllMocks())

describe('comment mutation events', () => {
  it('publishes lightweight routing metadata without comment data', async () => {
    const publish = vi.fn().mockResolvedValue(1)
    vi.mocked(getRedis).mockReturnValue({ publish } as never)
    await publishCommentMutation('octo:s:f:d_1', 'd_1', 12, 'updated')
    expect(publish).toHaveBeenCalledWith(commentEventsChannel(), expect.any(String))
    const payload = JSON.parse(publish.mock.calls[0]![1])
    expect(payload).toEqual({
      type: 'comment.changed', documentName: 'octo:s:f:d_1', docId: 'd_1',
      commentId: 12, action: 'updated',
    })
    expect(payload).not.toHaveProperty('body')
    expect(payload).not.toHaveProperty('anchorStart')
  })

  it('broadcasts the standardized payload over Hocuspocus stateless', () => {
    const broadcastStateless = vi.fn()
    vi.mocked(getCollabServer).mockReturnValue({
      hocuspocus: { documents: new Map([['octo:s:f:d_1', { broadcastStateless }]]) },
    } as never)
    broadcastCommentMutation(JSON.stringify({
      type: 'comment.changed', documentName: 'octo:s:f:d_1', docId: 'd_1',
      commentId: 12, action: 'created',
    }))
    expect(broadcastStateless).toHaveBeenCalledTimes(1)
    expect(JSON.parse(broadcastStateless.mock.calls[0]![0])).toEqual({
      type: 'comment.changed', docId: 'd_1', commentId: 12, action: 'created',
    })
  })

  it('defaults deny for malformed events or documents with no authenticated connections', () => {
    const broadcastStateless = vi.fn()
    vi.mocked(getCollabServer).mockReturnValue({
      hocuspocus: { documents: new Map([['octo:s:f:d_1', { broadcastStateless }]]) },
    } as never)
    broadcastCommentMutation('{}')
    broadcastCommentMutation(JSON.stringify({
      type: 'comment.changed', documentName: 'octo:s:f:d_1', docId: 'd_OTHER',
      commentId: 1, action: 'created',
    }))
    broadcastCommentMutation(JSON.stringify({
      type: 'comment.changed', documentName: 'octo:s:f:missing', docId: 'missing',
      commentId: 1, action: 'created',
    }))
    expect(broadcastStateless).not.toHaveBeenCalled()
  })
})
