# Durable output and artifact architecture

This is the implemented baseline for moving completed files from an untrusted
agent sandbox into Skynet, the browser, and outbound connectors without exposing
sandbox credentials or duplicating file-transfer logic.

## Implemented flow

```text
agent calls artifact_publish(path)
  -> trusted backend resolves org/user/run/thread from the capability token
  -> Daytona SDK checks size and pulls the sandbox file once
  -> ArtifactStorage writes immutable content-addressed bytes
  -> artifacts table records metadata + ownership + SHA-256
  -> durable artifact.created event enters the existing provider/canonical lane
  -> @skynet/agent-client validates typed artifact API responses
  -> React renders a gallery card and an inline conversation receipt
  -> browser preview/download reads the authenticated content endpoint

optional Slack delivery
  -> agent calls slack_upload(artifactId)
  -> backend verifies that artifact belongs to the exact org/thread
  -> durable Slack outbox references the same artifact id
  -> connector reads the same immutable bytes and uploads them
  -> only after Slack accepts the bytes, artifact.delivered appears in the timeline
```

Only bounded metadata references ride the event stream. File bytes never enter
SSE frames, prompts, canonical events, or the database.

## Trust and ownership

- The provider cannot supply an org, user, run, or thread id. Gateway token
  claims are the authority.
- Browser routes resolve organization membership server-side. Cross-org reads
  return `404`, including metadata and byte endpoints.
- The backend accepts only a file path inside the already attached run sandbox,
  caps downloads at 50 MiB before and after transfer, and records SHA-256.
- HTML and SVG are attachment-only on the application origin. Previewable files
  use `nosniff`, same-origin resource policy, private caching, safe content
  disposition, byte ranges, and immutable ETags.
- Slack tokens remain in the backend. The sandbox receives only a short-lived,
  run-scoped capability token and an artifact id.

## Reusable client contract

`@skynet/agent-client/artifacts` owns `ArtifactDescriptor` and strict wire
decoders. `createAgentClient` exposes the read-only product operations:

- `listArtifacts({ runId?, threadId? })`
- `getArtifact(artifactId)`

Publishing is intentionally absent from the browser client. Only an active
run-scoped agent capability may turn an arbitrary sandbox path into an artifact;
an ordinary web session cannot use the gallery API as a sandbox file reader.

The package remains runtime-neutral: no React, Next, provider, Daytona,
database, or Node runtime imports. Product UI owns filtering, layout, preview
renderers, and permission affordances.

## Storage and delivery semantics

`ArtifactStorage` is the portability seam. The current development adapter is a
content-addressed local directory configured by `ARTIFACT_STORAGE_DIR`; it uses
atomic writes and is appropriate for one backend node. A multi-replica
deployment must bind this interface to shared object storage before scaling the
backend horizontally.

Publishing the same run path and digest is idempotent. Changing bytes creates a
new artifact record. Slack enqueue is idempotent per artifact and destination.
The connector outbox is crash-durable and at-least-once across the external
network boundary: a crash after Slack accepts bytes but before the database
acknowledgement can still duplicate an upload. It does not claim impossible
exactly-once delivery from Slack.

Legacy outbox rows with a staged path remain readable during migration; all new
rows reference a durable artifact id.

## Current UI

- `/agent/artifacts` and `/artifacts` read real persisted descriptors.
- The gallery polls independently every five seconds and has explicit refresh,
  real MIME/name categories, preview/download actions, a truthful empty state,
  and session links.
- Raster images render a thumbnail. Other files render a type glyph and always
  retain preview/download access.
- `artifact.created` and `artifact.delivered` render as provider-neutral inline
  rows in both native and canonical timeline modes.

## Verification

`backend/test/e2e/artifact-delivery-live.ts` is the defining manual acceptance
journey. Against a fresh Daytona sandbox and throwaway database it proves exact
source/browser/Slack bytes, digest and ETag, range reads, duplicate publish and
Slack idempotency, reload discovery, and verified sandbox cleanup.

Unit and integration suites additionally pin cross-org denial, active-content
download behavior, missing-byte `410`, invalid-range `416`, gateway discovery,
canonical translation, React timeline equivalence, and client wire validation.

## Next renderer and operations layers

The implemented file lane deliberately does not pretend to be a full document
suite. Future work can attach behind these stable seams:

1. shared object-storage adapter, retention policy, orphan-byte garbage
   collection, quotas, and malware scanning;
2. version history and explicit sharing/ACL operations;
3. lazy product-owned renderers for PDF, documents, spreadsheets,
   presentations, video, datasets, and archives;
4. interactive HTML/app artifacts in a separate-origin sandboxed iframe with a
   narrow parent-verified RPC bridge and no ambient credentials;
5. connector delivery adapters beyond Slack.

These additions must preserve the existing rule: storage, authorization, and
connector policy stay in the trusted Skynet backend; the harness and client
packages carry provider-neutral references and typed operations only.
