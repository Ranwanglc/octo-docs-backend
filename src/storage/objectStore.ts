/**
 * Object-storage presign driver abstraction (§3.5).
 *
 * Binary blobs (images, files) never enter the Y.Doc or a DB large field —
 * they are uploaded directly to object storage and the Y.Doc keeps only a
 * reference (attach_id / object key). This module mints the URLs that flow:
 *   · step 1 — a presigned PUT URL the front-end uploads to directly;
 *   · step 5 — a freshly signed, time-limited GET URL re-issued at read time.
 *
 * The default `local-hmac` driver produces real, verifiable signatures using
 * Node's built-in `crypto` (no cloud creds, no aws-sdk/cos-sdk). The signed URL
 * embeds an expiry timestamp and an HMAC over (objectKey + expiry) keyed by a
 * config secret; `verifySignedUrl()` lets callers/tests assert validity and
 * expiry. A real COS/S3 driver can be slotted in behind the same `ObjectStore`
 * interface and selected via `config.attachments.driver`.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config/env.js'

export interface PresignedUpload {
  /** Fully-formed URL the client issues a PUT against. */
  uploadUrl: string
  /** Optional headers the client must echo on the PUT (e.g. Content-Type). */
  headers?: Record<string, string>
}

export interface ObjectStore {
  /** Mint a presigned PUT URL for `objectKey`, valid for `expiresSec`. */
  presignPut(objectKey: string, mime: string, expiresSec: number): PresignedUpload
  /**
   * Mint a signed, time-limited GET URL for `objectKey` (§3.5 step 5). When
   * `opts.contentDisposition` is set the value is bound into the signature and
   * carried as `response-content-disposition` so object storage replays it as
   * the response `Content-Disposition` header — used to force a download for
   * non-inline attachment types (§3.5). When `opts.responseContentType` is set
   * it is bound the same way and carried as `response-content-type`, so the
   * response is served with the trusted, denylist-checked registered mime rather
   * than the raw Content-Type the client sent on the PUT (stored XSS — XIN-726).
   */
  presignGet(objectKey: string, expiresSec: number, opts?: PresignGetOptions): string
  delete(objectKey: string): Promise<void>
  /** Server-side direct upload (PUT bytes). Uses internal endpoint when configured. */
  upload(objectKey: string, mime: string, body: Uint8Array, opts?: { signal?: AbortSignal }): Promise<void>
  /**
   * Server-side direct download (GET bytes). Uses internal endpoint when configured.
   * When `maxBytes` is set, reads the response as a stream and aborts past the cap,
   * preventing oversized objects from being fully buffered in memory (OOM defence).
   */
  download(objectKey: string, opts?: { maxBytes?: number }): Promise<Uint8Array>
}

export interface PresignGetOptions {
  /** Full Content-Disposition value, e.g. `attachment; filename="report.pdf"`. */
  contentDisposition?: string
  /**
   * Content-Type the GET response MUST be served with, bound into the signature
   * and carried as `response-content-type` so the gateway (and S3/MinIO, which
   * replays it natively) serves this trusted, denylist-checked mime instead of
   * the raw Content-Type header the client happened to send on the PUT — which
   * is attacker-controlled and otherwise enables stored XSS (XIN-726).
   */
  responseContentType?: string
}

export interface VerifyResult {
  valid: boolean
  /** Set when invalid, for diagnostics/tests: 'missing' | 'expired' | 'bad_signature'. */
  reason?: 'missing' | 'expired' | 'bad_signature'
}

/**
 * Compute the canonical HMAC signature over (method + objectKey + expiry), plus
 * any `extra` material (e.g. a content-disposition value) appended only when
 * present so legacy URLs without it keep their original, unchanged signature.
 * The method is bound so a GET signature can't be replayed as a PUT.
 */
function sign(
  method: 'PUT' | 'GET',
  objectKey: string,
  expiry: number,
  secret: string,
  extra = '',
): string {
  const base = `${method}\n${objectKey}\n${expiry}`
  return createHmac('sha256', secret)
    .update(extra ? `${base}\n${extra}` : base)
    .digest('hex')
}

/**
 * Compose the optional signed "extra" material appended to the canonical HMAC
 * input from the response overrides carried on a GET URL. Ordering and labels
 * are fixed so signing and verification agree, and a disposition-only URL keeps
 * its historical single-line form (byte-identical signature) — the content-type
 * line is only added when a trusted registered mime is bound (XIN-726). The
 * `content-type=` label disambiguates it from the disposition value.
 */
function responseExtra(contentDisposition?: string, contentType?: string): string {
  const parts: string[] = []
  if (contentDisposition) parts.push(contentDisposition)
  if (contentType) parts.push(`content-type=${contentType}`)
  return parts.join('\n')
}

/**
 * Prepend an optional, slash-normalised key prefix to a logical object key.
 * The prefix lets several apps share one bucket without colliding (e.g. a
 * Tencent COS bucket shared with octo-server). It is applied at the storage
 * boundary so the DB keeps the logical key while the signed URL — and thus the
 * signature — covers the full physical key. An empty prefix is a no-op, so
 * existing deployments sign exactly the keys they did before.
 */
function applyKeyPrefix(prefix: string, objectKey: string): string {
  const p = prefix.replace(/^\/+|\/+$/g, '')
  return p ? `${p}/${objectKey}` : objectKey
}

/** Constant-time hex-string comparison (avoids signature timing leaks). */
function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * Default dev/self-hosted driver: deterministic, TTL-bounded HMAC-signed URLs.
 * The base host is derived from the configured bucket; the path is the object
 * key, and the query carries the expiry + signature. `nowSec` is injectable so
 * tests can assert expiry behaviour deterministically.
 */
export class LocalHmacObjectStore implements ObjectStore {
  private readonly bucket: string
  private readonly secret: string
  private readonly keyPrefix: string
  private readonly publicBaseUrl: string
  private readonly nowSec: () => number

  constructor(opts?: {
    bucket?: string
    secret?: string
    keyPrefix?: string
    publicBaseUrl?: string
    nowSec?: () => number
  }) {
    this.bucket = opts?.bucket ?? config.attachments.bucket
    this.secret = opts?.secret ?? config.attachments.signingSecret
    this.keyPrefix = opts?.keyPrefix ?? config.attachments.keyPrefix
    // Strip any trailing slash so key joining stays canonical; empty means the
    // legacy object-store.local host (see baseUrl()).
    this.publicBaseUrl = (opts?.publicBaseUrl ?? config.attachments.publicBaseUrl).replace(
      /\/+$/,
      '',
    )
    this.nowSec = opts?.nowSec ?? (() => Math.floor(Date.now() / 1000))
  }

  private baseUrl(physicalKey: string): string {
    // Path-style URL: each key segment is encoded but the '/' separators are
    // preserved so the key round-trips cleanly. When a public base URL is
    // configured the signed URL points at that browser-reachable origin
    // (XIN-713); otherwise it falls back to the historical bucket host, which is
    // an internal alias the end-user browser cannot resolve.
    const encodedKey = physicalKey.split('/').map(encodeURIComponent).join('/')
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl}/${encodedKey}`
    }
    return `https://${this.bucket}.object-store.local/${encodedKey}`
  }

  /**
   * The path segment carried by a configured public base URL (e.g. `/attachments`
   * for `http://host:8092/attachments`), normalised without a trailing slash.
   * Empty when no base URL is set or the base URL is origin-only. verify() strips
   * this prefix before reconstructing the signed object key, so mounting the
   * attachment host under a path does not change the signed key.
   */
  private basePathPrefix(): string {
    if (!this.publicBaseUrl) return ''
    let path: string
    try {
      path = new URL(this.publicBaseUrl).pathname
    } catch {
      return ''
    }
    const trimmed = path.replace(/\/+$/, '')
    return trimmed === '' || trimmed === '/' ? '' : trimmed
  }

  private signedUrl(
    method: 'PUT' | 'GET',
    objectKey: string,
    expiresSec: number,
    contentDisposition?: string,
    contentType?: string,
  ): string {
    // The prefix is bound into both the URL path and the signature so a key
    // signed with one prefix can't be replayed under another.
    const physicalKey = applyKeyPrefix(this.keyPrefix, objectKey)
    const expiry = this.nowSec() + expiresSec
    const signature = sign(
      method,
      physicalKey,
      expiry,
      this.secret,
      responseExtra(contentDisposition, contentType),
    )
    const url = new URL(this.baseUrl(physicalKey))
    url.searchParams.set('X-Method', method)
    url.searchParams.set('X-Expiry', String(expiry))
    // Bound into the HMAC above; the self-hosted gateway in front of this driver
    // MUST replay it as `Content-Disposition` AND add `X-Content-Type-Options:
    // nosniff` on every attachment response — signing only proves the value
    // wasn't tampered with, it does not make the gateway emit the header (§3.5
    // S1). Without that gateway work the local-hmac path has no XSS defence.
    if (contentDisposition) {
      url.searchParams.set('response-content-disposition', contentDisposition)
    }
    // The trusted, denylist-checked mime the GET response must be served with,
    // bound into the signature so the gateway serves it instead of the raw
    // Content-Type the client sent on the PUT (stored XSS — XIN-726).
    if (contentType) {
      url.searchParams.set('response-content-type', contentType)
    }
    url.searchParams.set('X-Signature', signature)
    return url.toString()
  }

  presignPut(objectKey: string, mime: string, expiresSec: number): PresignedUpload {
    return {
      uploadUrl: this.signedUrl('PUT', objectKey, expiresSec),
      headers: { 'Content-Type': mime },
    }
  }

  presignGet(objectKey: string, expiresSec: number, opts?: PresignGetOptions): string {
    return this.signedUrl(
      'GET',
      objectKey,
      expiresSec,
      opts?.contentDisposition,
      opts?.responseContentType,
    )
  }

  async delete(objectKey: string): Promise<void> {
    const { getLocalBlobStore } = await import('./localBlobStore.js')
    await getLocalBlobStore().delete(applyKeyPrefix(this.keyPrefix, objectKey))
  }

  async upload(objectKey: string, mime: string, body: Uint8Array): Promise<void> {
    const { getLocalBlobStore } = await import('./localBlobStore.js')
    await getLocalBlobStore().put(applyKeyPrefix(this.keyPrefix, objectKey), mime, Buffer.from(body))
  }

  async download(objectKey: string, opts?: { maxBytes?: number }): Promise<Uint8Array> {
    const { getLocalBlobStore } = await import('./localBlobStore.js')
    const stored = await getLocalBlobStore().get(applyKeyPrefix(this.keyPrefix, objectKey))
    if (!stored) throw new Error(`object not found: ${objectKey}`)
    if (opts?.maxBytes !== undefined && stored.bytes.length > opts.maxBytes) {
      throw new Error(`downloaded object exceeds maxBytes cap: ${stored.bytes.length} > ${opts.maxBytes}`)
    }
    return new Uint8Array(stored.bytes)
  }

  /**
   * Verify a previously minted URL: checks the signature matches and the expiry
   * has not passed. Bound to this driver's secret. Exposed for tests and for a
   * future read-proxy that validates inbound signed URLs.
   */
  verify(signedUrl: string): VerifyResult {
    return this.parseAndVerify(signedUrl).result
  }

  /**
   * Verify a signed URL for a concrete HTTP request (XIN-717): in addition to
   * the signature + expiry checks, the URL's bound `X-Method` must match the
   * actual HTTP method, so a GET-signed URL can never be replayed as a PUT. On
   * success returns the physical object key (prefix-applied, the same key the
   * signature covers) so the blob gateway knows where to store / read the bytes.
   */
  verifyRequest(
    httpMethod: string,
    signedUrl: string,
  ): VerifyResult & { objectKey?: string; disposition?: string; contentType?: string } {
    const { result, method, physicalKey, disposition, contentType } =
      this.parseAndVerify(signedUrl)
    if (!result.valid) return result
    if (method !== httpMethod.toUpperCase()) {
      return { valid: false, reason: 'bad_signature' }
    }
    return { valid: true, objectKey: physicalKey, disposition, contentType }
  }

  /**
   * Shared parse + signature/expiry verification for both verify() and
   * verifyRequest(). Reconstructs the physical object key from the URL path
   * (stripping any configured base-path segment), recomputes the HMAC over
   * (method + key + expiry [+ disposition]) and compares in constant time.
   */
  private parseAndVerify(signedUrl: string): {
    result: VerifyResult
    method?: 'PUT' | 'GET'
    physicalKey?: string
    disposition?: string
    contentType?: string
  } {
    let url: URL
    try {
      url = new URL(signedUrl)
    } catch {
      return { result: { valid: false, reason: 'missing' } }
    }
    const method = url.searchParams.get('X-Method')
    const expiryStr = url.searchParams.get('X-Expiry')
    const signature = url.searchParams.get('X-Signature')
    if (!method || !expiryStr || !signature || (method !== 'PUT' && method !== 'GET')) {
      return { result: { valid: false, reason: 'missing' } }
    }
    const expiry = Number(expiryStr)
    if (!Number.isFinite(expiry)) return { result: { valid: false, reason: 'missing' } }

    // Reconstruct the physical object key from the path (decode each segment).
    // This is the prefixed key that was signed at mint time, so verification is
    // self-consistent without needing to know the prefix here. When the signed
    // URL points at a public base URL that carries a path segment (e.g.
    // `http://host:8092/attachments`), that segment is stripped first so the
    // reconstructed key is the pure object key that was actually signed.
    const basePath = this.basePathPrefix()
    let pathname = url.pathname
    if (basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))) {
      pathname = pathname.slice(basePath.length)
    }
    const physicalKey = pathname
      .replace(/^\//, '')
      .split('/')
      .map(decodeURIComponent)
      .join('/')

    // Disposition (when present) is part of the signed material; '' otherwise so
    // legacy URLs without it verify against the original signature form. The
    // response content-type override is bound the same way (XIN-726).
    const disposition = url.searchParams.get('response-content-disposition') ?? ''
    const contentType = url.searchParams.get('response-content-type') ?? ''
    const expected = sign(
      method,
      physicalKey,
      expiry,
      this.secret,
      responseExtra(disposition || undefined, contentType || undefined),
    )
    if (!safeEqualHex(expected, signature)) {
      return { result: { valid: false, reason: 'bad_signature' } }
    }
    if (this.nowSec() >= expiry) return { result: { valid: false, reason: 'expired' } }
    return {
      result: { valid: true },
      method,
      physicalKey,
      disposition: disposition === '' ? undefined : disposition,
      contentType: contentType === '' ? undefined : contentType,
    }
  }
}

/**
 * RFC-3986 URI encoding as required by AWS SigV4. `encodeURIComponent` already
 * leaves the unreserved set (A-Z a-z 0-9 - _ . ~) untouched, but it does NOT
 * escape `! * ' ( )` — AWS does — so we percent-escape those too. Slashes in a
 * path are encoded segment-by-segment by the caller so the separators survive.
 */
function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function sha256Hex(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Real S3-compatible driver (MinIO, AWS S3, Tencent COS, …) that mints AWS
 * Signature V4 presigned query-string URLs using only Node's built-in crypto —
 * no aws-sdk / minio / cos package. MinIO and COS are both SigV4 compatible
 * (service=s3), so a correctly built presigned URL works against them unchanged.
 *
 * Two addressing modes, selected by `forcePathStyle`:
 *   · path-style (default, MinIO): URL = `<endpoint>/<bucket>/<key>` and the
 *     canonicalUri carries the bucket segment.
 *   · virtual-hosted / custom-domain (`forcePathStyle: false`, COS CDN domain):
 *     the host is already bound to the bucket, so URL = `<endpoint>/<key>` and
 *     the canonicalUri drops the bucket — otherwise COS computes a different
 *     canonical request and rejects the signature (403 SignatureDoesNotMatch).
 *
 * The host baked into the signed URL is the configured *public*,
 * browser-reachable endpoint (never a docker-internal alias), since the
 * front-end issues the PUT/GET directly. An optional `keyPrefix` is prepended
 * to every key before signing. Presigning is pure signing with no network call.
 * `nowSec` is injectable so tests can assert the embedded `X-Amz-Date`
 * deterministically.
 */
export class S3ObjectStore implements ObjectStore {
  private readonly endpoint: string
  private readonly internalEndpoint: string
  private readonly region: string
  private readonly bucket: string
  private readonly accessKeyId: string
  private readonly secretAccessKey: string
  private readonly forcePathStyle: boolean
  private readonly keyPrefix: string
  private readonly signingHost: string
  private readonly nowSec: () => number
  private static readonly SERVICE = 's3'

  constructor(opts: {
    endpoint: string
    internalEndpoint?: string
    region: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
    forcePathStyle?: boolean
    keyPrefix?: string
    signingHost?: string
    nowSec?: () => number
  }) {
    // Strip any trailing slash so path joining stays canonical.
    this.endpoint = opts.endpoint.replace(/\/+$/, '')
    // Container-network endpoint for server-side PUT/DELETE/GET; falls back to
    // the public endpoint when unset (single-network/dev deployments).
    this.internalEndpoint = (opts.internalEndpoint || '').replace(/\/+$/, '') || this.endpoint
    this.region = opts.region
    this.bucket = opts.bucket
    this.accessKeyId = opts.accessKeyId
    this.secretAccessKey = opts.secretAccessKey
    // Default true preserves the historical path-style behaviour for MinIO.
    this.forcePathStyle = opts.forcePathStyle ?? true
    this.keyPrefix = opts.keyPrefix ?? ''
    this.signingHost = opts.signingHost ?? ''
    this.nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000))
  }

  /**
   * Canonical URI for SigV4. Path-style includes the bucket segment
   * (`/<bucket>/<key>`); virtual-hosted / custom-domain addressing omits it
   * (`/<key>`) because the host already resolves to the bucket. `physicalKey`
   * is the prefix-applied key, encoded segment-by-segment so '/' survives.
   */
  private canonicalUri(physicalKey: string): string {
    const encodedKey = physicalKey.split('/').map(awsUriEncode).join('/')
    if (this.forcePathStyle) {
      return `/${awsUriEncode(this.bucket)}/${encodedKey}`
    }
    return `/${encodedKey}`
  }

  private presign(
    method: 'PUT' | 'GET' | 'DELETE',
    objectKey: string,
    expiresSec: number,
    contentDisposition?: string,
    contentType?: string,
  ): string {
    const url = new URL(this.endpoint)
    // Host header carries the port when non-default; it must match the URL host
    // exactly or the signature will not verify. With a CDN/custom domain that
    // origin-pulls to the bucket, the host the storage backend actually sees
    // (and signs against) differs from the public URL host — `signingHost`
    // overrides it for that case; otherwise we sign the endpoint host itself.
    const host = url.host
    const signedHost = this.signingHost || host

    const physicalKey = applyKeyPrefix(this.keyPrefix, objectKey)

    const now = new Date(this.nowSec() * 1000)
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '') // YYYYMMDDTHHMMSSZ
    const dateStamp = amzDate.slice(0, 8) // YYYYMMDD
    const credentialScope = `${dateStamp}/${this.region}/${S3ObjectStore.SERVICE}/aws4_request`

    // X-Amz-* query params that participate in the signature. Content-Type is
    // intentionally NOT signed (SignedHeaders=host only) so the browser can set
    // it freely on the PUT.
    const params: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.accessKeyId}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresSec),
      'X-Amz-SignedHeaders': 'host',
    }
    // S3/MinIO natively replays `response-content-disposition` as the response
    // Content-Disposition header; signing it (it joins the canonical query
    // below) is sufficient to force a download for non-inline types (§3.5).
    if (contentDisposition) {
      params['response-content-disposition'] = contentDisposition
    }
    // Likewise `response-content-type` is replayed as the response Content-Type,
    // so the trusted registered mime is served instead of the raw PUT header
    // (stored XSS — XIN-726).
    if (contentType) {
      params['response-content-type'] = contentType
    }

    const canonicalQuery = Object.entries(params)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`)
      .join('&')

    const canonicalUri = this.canonicalUri(physicalKey)
    const canonicalHeaders = `host:${signedHost}\n`
    const signedHeaders = 'host'
    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      'UNSIGNED-PAYLOAD',
    ].join('\n')

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n')

    const kDate = hmac(`AWS4${this.secretAccessKey}`, dateStamp)
    const kRegion = hmac(kDate, this.region)
    const kService = hmac(kRegion, S3ObjectStore.SERVICE)
    const kSigning = hmac(kService, 'aws4_request')
    const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

    return `${url.protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
  }

  presignPut(objectKey: string, mime: string, expiresSec: number): PresignedUpload {
    return {
      uploadUrl: this.presign('PUT', objectKey, expiresSec),
      // Echoed by the client on the PUT but deliberately left out of the
      // signed headers (see presign()).
      headers: { 'Content-Type': mime },
    }
  }

  presignGet(objectKey: string, expiresSec: number, opts?: PresignGetOptions): string {
    return this.presign(
      'GET',
      objectKey,
      expiresSec,
      opts?.contentDisposition,
      opts?.responseContentType,
    )
  }

  async delete(objectKey: string): Promise<void> {
    await this.internalRequest('DELETE', objectKey)
  }

  async upload(objectKey: string, mime: string, body: Uint8Array, opts?: { signal?: AbortSignal }): Promise<void> {
    await this.internalRequest('PUT', objectKey, { mime, body, signal: opts?.signal })
  }

  async download(objectKey: string, opts?: { maxBytes?: number }): Promise<Uint8Array> {
    return this.internalRequest('GET', objectKey, { maxBytes: opts?.maxBytes })
  }

  /**
   * Issue a signed SigV4 Authorization-header request against the internal
   * (container-network) endpoint. PUT takes a mime+body; GET returns the response
   * bytes as Uint8Array (with streaming cap when maxBytes is set); DELETE returns
   * void (404 tolerated).
   */
  private async internalRequest(
    method: 'PUT' | 'GET' | 'DELETE',
    objectKey: string,
    opts?: { mime?: string; body?: Uint8Array; maxBytes?: number; signal?: AbortSignal },
  ): Promise<Uint8Array> {
    const physicalKey = applyKeyPrefix(this.keyPrefix, objectKey)
    const url = new URL(this.internalEndpoint)
    const host = url.host
    // When a distinct internal endpoint is configured the request goes directly
    // to S3/MinIO (no Host-rewriting proxy), so sign against that host. When no
    // internal endpoint is set we fall through to the public endpoint, which in
    // COS-behind-CDN deployments rewrites Host to the origin bucket before SigV4
    // validation — so keep signing against `signingHost` (same as presign URLs).
    const signedHost = this.internalEndpoint !== this.endpoint
      ? host
      : (this.signingHost || host)
    const canonicalUri = this.canonicalUri(physicalKey)

    const now = new Date(this.nowSec() * 1000)
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
    const dateStamp = amzDate.slice(0, 8)
    const credentialScope = `${dateStamp}/${this.region}/${S3ObjectStore.SERVICE}/aws4_request`

    const payloadHash = method === 'PUT' && opts?.body
      ? sha256Hex(Buffer.from(opts.body))
      : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

    const headers: Record<string, string> = {
      host: signedHost,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    }
    if (method === 'PUT' && opts?.mime) {
      headers['content-type'] = opts.mime
    }

    const signedHeaderKeys = Object.keys(headers).sort()
    const signedHeaders = signedHeaderKeys.join(';')
    const canonicalHeaders = signedHeaderKeys.map(k => `${k}:${headers[k]}`).join('\n') + '\n'

    const canonicalRequest = [
      method,
      canonicalUri,
      '', // canonicalQuery — empty for Authorization-header mode
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n')

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n')

    const kDate = hmac(`AWS4${this.secretAccessKey}`, dateStamp)
    const kRegion = hmac(kDate, this.region)
    const kService = hmac(kRegion, S3ObjectStore.SERVICE)
    const kSigning = hmac(kService, 'aws4_request')
    const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

    const requestUrl = `${url.protocol}//${host}${canonicalUri}`
    const fetchHeaders: Record<string, string> = {
      ...headers,
      Authorization: authorization,
    }

    const response = await fetch(requestUrl, {
      method,
      headers: fetchHeaders,
      body: method === 'PUT' && opts?.body ? Buffer.from(opts.body) : undefined,
      signal: opts?.signal,
    })

    if (!response.ok) {
      if (method === 'DELETE' && response.status === 404) return new Uint8Array()
      const text = await response.text().catch(() => '')
      throw new Error(`internal ${method} ${objectKey} failed: ${response.status} ${text.slice(0, 200)}`)
    }

    if (method === 'GET') {
      // Streaming read with optional byte cap: abort the reader past maxBytes so
      // an oversized object (e.g. stale/understated sizeBytes row) never fully
      // buffers in memory — mirrors the old readCapped() defence.
      if (!response.body) return new Uint8Array()
      const maxBytes = opts?.maxBytes
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            total += value.byteLength
            if (maxBytes !== undefined && total > maxBytes) {
              await reader.cancel().catch(() => {})
              throw new Error(`internal GET ${objectKey} exceeds maxBytes cap: ${total} > ${maxBytes}`)
            }
            chunks.push(value)
          }
        }
      } catch (err) {
        await reader.cancel().catch(() => {})
        throw err
      }
      return Buffer.concat(chunks.map(c => Buffer.from(c)))
    }
    return new Uint8Array()
  }
}

let defaultStore: LocalHmacObjectStore | null = null
let s3Store: S3ObjectStore | null = null

/**
 * Resolve the configured ObjectStore driver. The interface is identical across
 * drivers so callers (the presign/read routes) need no change when switching:
 *   · 'local-hmac' (default) — zero-dependency HMAC-signed URLs for dev;
 *   · 's3' / 'minio' — real AWS SigV4 presigned URLs against an S3-compatible
 *     endpoint (the signed URL host is the public, browser-reachable endpoint).
 */
export function getObjectStore(): ObjectStore {
  switch (config.attachments.driver) {
    case 's3':
    case 'minio':
      if (!s3Store) {
        s3Store = new S3ObjectStore({
          endpoint: config.attachments.s3.endpoint,
          internalEndpoint: config.attachments.s3.internalEndpoint,
          region: config.attachments.s3.region,
          bucket: config.attachments.bucket,
          accessKeyId: config.attachments.s3.accessKeyId,
          secretAccessKey: config.attachments.s3.secretAccessKey,
          forcePathStyle: config.attachments.s3.forcePathStyle,
          keyPrefix: config.attachments.keyPrefix,
          signingHost: config.attachments.s3.signingHost,
        })
      }
      return s3Store
    case 'local-hmac':
    default:
      if (!defaultStore) defaultStore = new LocalHmacObjectStore()
      return defaultStore
  }
}

/**
 * Verify a signed URL against the default driver's secret. Convenience wrapper
 * used by tests; returns false for drivers that don't support local verification.
 */
export function verifySignedUrl(signedUrl: string): VerifyResult {
  const store = getObjectStore()
  if (store instanceof LocalHmacObjectStore) return store.verify(signedUrl)
  return { valid: false, reason: 'missing' }
}
