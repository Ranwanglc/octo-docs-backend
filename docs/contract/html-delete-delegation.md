# HTML delete delegation contract

The trusted HTML service calls exactly:

```http
DELETE /v1/internal/html-docs
Content-Type: application/json
X-Octo-Timestamp: <Unix seconds>
X-Octo-Signature: v1=<64 lowercase hex HMAC>
```

The UTF-8 JSON body is limited to 4096 bytes. Its exact schema is:

```json
{"slug":"<slug>","docId":"<canonical doc id>","actorUid":"<authenticated uid>","superAdmin":false}
```

`docId` is required for canonical documents and omitted only for a legacy
slug-registered document. No extra keys are accepted. `superAdmin` is trusted
only after this request's HMAC verifies. When false, the backend re-resolves
`actorUid`'s current document role and requires `admin`.

Compute `bodyHash = lowercaseHex(SHA256(exactBodyBytes))`, then HMAC these UTF-8
bytes (no final newline):

```text
v1\nDELETE\n/v1/internal/html-docs\n<timestamp>\n<bodyHash>
```

Set `X-Octo-Signature` to `v1=` plus the lowercase hex HMAC-SHA256 using
`DOCS_HTML_DELEGATION_SECRET`. Timestamps may differ from backend time by at most
300 seconds. Do not reserialize or mutate the body after hashing. Human session
and bot authorization headers have no effect on this endpoint.

Success, including an idempotent retry of the same deleted canonical target, is
`204 No Content`. Relevant failures are `400` invalid/non-HTML input, `401`
signature/timestamp failure, `403` actor not currently admin, `404` missing
target, `409` archived/canonical mismatch/ambiguous legacy slug, `413` body over
4096 bytes, and `503` absent delegation secret. Empty secret disables the
endpoint; a configured secret must be at least 32 bytes.
