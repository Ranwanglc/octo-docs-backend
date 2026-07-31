import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fake kafka producer whose send() records the call args into an in-memory log,
// so we can assert the topic, message key/value and acks without a live broker.
// Mirrors the offline-mock style the Redis version used.
interface SendCall {
  topic: string
  acks?: number
  messages: Array<{ key?: string; value: string }>
}
const sendCalls: SendCall[] = []
let failSend = false

vi.mock('../src/db/kafka.js', () => ({
  getKafkaProducer: async () => ({
    async send(args: SendCall) {
      if (failSend) throw new Error('kafka down')
      sendCalls.push(args)
      return [{ topicName: args.topic }]
    },
  }),
}))

import {
  enqueueDocIndex,
  isSearchIndexedDoc,
  docIndexTopic,
} from '../src/search/docIndexQueue.js'
import { config } from '../src/config/env.js'

beforeEach(() => {
  sendCalls.length = 0
  failSend = false
})

describe('isSearchIndexedDoc — which docs get enqueued', () => {
  it('accepts document (doc/sheet, 4-seg) keys', () => {
    expect(isSearchIndexedDoc('octo:sp1:fol1:doc1')).toBe(true)
  })
  it('accepts html (5-seg) keys — body resolved from octo-docs-html S3 by the indexer', () => {
    expect(isSearchIndexedDoc('octo:sp1:fol1:html:doc2')).toBe(true)
  })
  it('accepts whiteboards (board, :wb: key — has an extractable Yjs body)', () => {
    expect(isSearchIndexedDoc('octo:sp1:fol1:wb:board1')).toBe(true)
  })
  it('rejects malformed names (parse failure => fail-safe drop)', () => {
    expect(isSearchIndexedDoc('not-a-doc-name')).toBe(false)
    expect(isSearchIndexedDoc('')).toBe(false)
  })
})

describe('enqueueDocIndex — producer', () => {
  it('sends a body signal to the topic, keyed by documentName, with a JSON value', async () => {
    const ok = await enqueueDocIndex('octo:sp1:fol1:doc1', 'body')
    expect(ok).toBe(true)
    expect(sendCalls).toHaveLength(1)
    const call = sendCalls[0]!
    expect(call.topic).toBe(docIndexTopic())
    expect(call.messages).toHaveLength(1)
    const m = call.messages[0]!
    // key = documentName so all signals for one doc land on the same partition.
    expect(m.key).toBe('octo:sp1:fol1:doc1')
    const signal = JSON.parse(m.value)
    expect(signal.documentName).toBe('octo:sp1:fol1:doc1')
    expect(signal.kind).toBe('body')
    expect(typeof signal.ts).toBe('number')
    expect(signal.ts).toBeGreaterThan(0)
  })

  it('defaults kind to body', async () => {
    await enqueueDocIndex('octo:sp1:fol1:doc1')
    expect(JSON.parse(sendCalls[0]!.messages[0]!.value).kind).toBe('body')
  })

  it('produces to the configured topic (must match indexer DOCINDEX_KAFKA_TOPIC)', () => {
    expect(docIndexTopic()).toBe(config.kafka.topic)
  })

  it('sends with the configured acks level', async () => {
    await enqueueDocIndex('octo:sp1:fol1:doc1', 'body')
    expect(sendCalls[0]!.acks).toBe(config.kafka.acks)
  })

  it('swallows a producer failure, returns false, and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    failSend = true
    const ok = await enqueueDocIndex('octo:sp1:fol1:doc1', 'body')
    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
