# Future output/artifact architecture (documented contract only)

This is a **design contract**, not implemented code. It records how real, durable agent
outputs (documents, spreadsheets, presentations, PDFs, images, code, HTML, apps,
dashboards, datasets, archives) will attach to the existing thread stream WITHOUT changing
the provider translators, adding provider branches to React, replacing the thread stream,
or moving product auth/policy into a library. Informed by Cloudflare OS
(`cloudflare/cloudflare-os`, audited snapshot `1cb5e3d9…`, Apache-2.0) as an ARCHITECTURE
reference only - no code, runtime, Kumo/Cap'n Web/Yjs/TanStack, or `.gadget` archives are
adopted.

## The flow

```
provider tool/file result
  -> Skynet-authorized artifact ingestion            (backend; org/user resolved server-side)
  -> durable ArtifactDescriptor + versioned content reference
  -> the EXISTING thread event stream emits small artifact lifecycle references
  -> @skynet/agent-client indexes artifacts by stable id/version
  -> a product-owned ArtifactRendererRegistry selects a lazy renderer
  -> the current right pane / output gallery renders it
```

Only small **references** ride the SSE/canonical rows. Bytes are stored out of band.

## Reserved architecture (no runtime yet)

- **kinds**: `document`, `presentation`, `spreadsheet`, `pdf`, `image`, `code`, `html`,
  `app`, `dashboard`, `dataset`, `archive`, `unknown`.
- **lifecycle**: `created`, `updated`, `completed`, `failed`.
- **descriptor fields**: title, MIME type, size, hash, version, producer/run/thread
  identity, a bounded preview reference, an authorized content/download reference, and
  capabilities (`preview` / `download` / `edit` / `export` / `version-history`).
- **ownership + ACL**: organization/user ownership and the product ACL are resolved by the
  **trusted Skynet backend**. A provider or an artifact cannot grant itself sharing or a
  wider scope. Self-declared labels/icons/format hints are harmless DISPLAY hints, never
  authority (Cloudflare OS's blueprint/gadget trust distinction: an output may declare
  presentation metadata, but only product/admin-curated configuration decides which formats
  are officially offered).
- **storage**: large bytes live out of band (object storage), never inside SSE frames or
  canonical rows.
- **access**: short-lived, authorized fetches; no public sandbox URL and no long-lived
  token.

## Two renderer lanes (product-owned registry)

The `ArtifactRendererRegistry` is keyed by kind/MIME and lives in the **app**, not in this
library. Two lanes:

1. **native file lane** - preserve/download the original and render a safe DERIVED preview
   (e.g. PDF pages, a table) through a pluggable converter.
2. **interactive app lane** - a sandboxed iframe with an explicit capability/RPC bridge,
   strict CSP, no ambient network or credentials, and parent-verified messages. This is
   Cloudflare OS's promoted "blueprint -> sandboxed web gadget" model for Documents/Sheets/
   Slides. Note it is NOT the same as native `.docx`/`.xlsx`/`.pptx` fidelity.

## Current truth (do not overstate)

`frontend/app/agent/artifacts/derive.ts` SYNTHESIZES artifact names, extensions, sizes,
and folder lanes deterministically from run/step ids because the backend has **no real
artifact concept**. The `/agent/artifacts` page is a derived view of `kind:"file"` steps,
NOT durable artifact storage. None of the architecture above is built; when it is
scheduled, it slots behind these seams without touching provider translators, React
provider branches, the thread stream, or where product auth/policy lives.
