import { afterEach, describe, expect, it, vi } from 'vitest'

import { logBotGrantFailure, logBotGrantSummary } from '../src/api/services/botGrantAudit.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('botGrantAudit', () => {
  it('does not log secret-bearing exception details', () => {
    const error = new Error('request failed: token=super-secret https://internal.example/sql?q=SELECT')
    error.name = 'SecretError-super-secret'
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    logBotGrantFailure({
      docId: 'doc_1',
      requestId: 'req_1',
      botUid: 'bot_1',
      error,
    })

    expect(log).toHaveBeenCalledWith('[octo-docs] access-request bot grant failed', {
      docId: 'doc_1',
      requestId: 'req_1',
      botUid: 'bot_1',
      code: 'BOT_GRANT_FAILED',
      errorCategory: 'Error',
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain('super-secret')
    expect(JSON.stringify(log.mock.calls)).not.toContain('request failed')
  })

  it('caps succeeded and failed uid arrays at 50 while retaining full counts', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const botsSucceeded = Array.from({ length: 75 }, (_, index) => `succeeded_${index}`)
    const botsFailed = Array.from({ length: 80 }, (_, index) => `failed_${index}`)

    logBotGrantSummary({
      source: 'rest',
      docId: 'doc_1',
      requestId: 'req_1',
      result: { requesterRole: 'writer', botsSucceeded, botsFailed },
    })

    const record = log.mock.calls[0]?.[1]
    expect(record).toMatchObject({ succeededCount: 75, failedCount: 80 })
    expect(record.succeededBotUids).toHaveLength(50)
    expect(record.failedBotUids).toHaveLength(50)
    expect(record.succeededBotUids).not.toContain('succeeded_50')
    expect(record.failedBotUids).not.toContain('failed_50')
  })
})
