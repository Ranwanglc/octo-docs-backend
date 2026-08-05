import type { GrantWithBotsResult } from './grantRequestWithBots.js'

const MAX_LOGGED_BOT_UIDS = 50

const SAFE_ERROR_CATEGORIES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
])

function errorCategory(error: unknown): string {
  if (!(error instanceof Error)) return 'NonErrorThrown'
  return SAFE_ERROR_CATEGORIES.has(error.name) ? error.name : 'Error'
}

export function logBotGrantFailure(fields: {
  docId: string
  requestId: string
  botUid: string
  error: unknown
}): void {
  // eslint-disable-next-line no-console
  console.error('[octo-docs] access-request bot grant failed', {
    docId: fields.docId,
    requestId: fields.requestId,
    botUid: fields.botUid,
    code: 'BOT_GRANT_FAILED',
    errorCategory: errorCategory(fields.error),
  })
}

export function logBotGrantSummary(fields: {
  source: 'rest' | 'card_callback'
  docId: string
  requestId: string
  result: GrantWithBotsResult
}): void {
  const record = {
    source: fields.source,
    docId: fields.docId,
    requestId: fields.requestId,
    succeededCount: fields.result.botsSucceeded.length,
    failedCount: fields.result.botsFailed.length,
    succeededBotUids: fields.result.botsSucceeded.slice(0, MAX_LOGGED_BOT_UIDS),
    failedBotUids: fields.result.botsFailed.slice(0, MAX_LOGGED_BOT_UIDS),
  }
  if (fields.result.botsFailed.length > 0) {
    // eslint-disable-next-line no-console
    console.error('[octo-docs] access-request bot grant partial failure', record)
  } else {
    // eslint-disable-next-line no-console
    console.info('[octo-docs] access-request bot grant completed', record)
  }
}
