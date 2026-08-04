import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/db/repos/docAttachmentRepo.js', () => ({
  docAttachmentRepo: { register: vi.fn() },
}))

const uploadFn = vi.fn(async () => undefined)
const deleteFn = vi.fn(async () => undefined)
vi.mock('../src/storage/objectStore.js', () => ({
  getObjectStore: () => ({
    upload: uploadFn,
    delete: deleteFn,
  }),
}))

// Fix config.docxImport.timeoutMs to a known value so AbortSignal.timeout is predictable.
vi.mock('../src/config/env.js', () => ({
  config: {
    docxImport: { timeoutMs: 30_000 },
    attachments: { uploadUrlTtlSeconds: 300 },
  },
}))

import { uploadExcalidrawAttachment, ExcalidrawImportError } from '../src/import/excalidraw.js'
import { docAttachmentRepo } from '../src/db/repos/docAttachmentRepo.js'

beforeEach(() => {
  vi.clearAllMocks()
  uploadFn.mockReset()
  deleteFn.mockReset()
  uploadFn.mockResolvedValue(undefined)
  deleteFn.mockResolvedValue(undefined)
  vi.mocked(docAttachmentRepo.register).mockResolvedValue(undefined as never)
})

describe('uploadExcalidrawAttachment', () => {
  it('passes an AbortSignal to store.upload for wall-clock timeout', async () => {
    await uploadExcalidrawAttachment('d_1', 'u_1', Buffer.from([0x89, 0x50]), 'image/png', 'photo.png')

    expect(uploadFn).toHaveBeenCalledTimes(1)
    const call = uploadFn.mock.calls[0]!
    // 4th arg is the options bag containing signal
    expect(call.length).toBeGreaterThanOrEqual(4)
    const opts = call[3] as { signal?: AbortSignal }
    expect(opts).toBeDefined()
    expect(opts.signal).toBeInstanceOf(AbortSignal)
    // The signal should be a timeout signal (not already aborted immediately for reasonable inputs).
    expect(opts.signal!.aborted).toBe(false)
  })

  it('throws ExcalidrawImportError with code upload_failed when store.upload rejects', async () => {
    uploadFn.mockRejectedValue(new Error('connection refused'))
    await expect(
      uploadExcalidrawAttachment('d_1', 'u_1', Buffer.from([0x89]), 'image/png', 'x.png'),
    ).rejects.toBeInstanceOf(ExcalidrawImportError)
    // register must not be called on upload failure
    expect(docAttachmentRepo.register).not.toHaveBeenCalled()
  })

  it('cleans up the uploaded object when register fails', async () => {
    vi.mocked(docAttachmentRepo.register).mockRejectedValue(new Error('db down'))
    await expect(
      uploadExcalidrawAttachment('d_1', 'u_1', Buffer.from([0x89]), 'image/png', 'x.png'),
    ).rejects.toThrow('db down')
    expect(deleteFn).toHaveBeenCalledTimes(1)
  })
})
