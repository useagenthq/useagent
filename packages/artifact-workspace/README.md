# @useagent/artifact-workspace

The browser-safe artifact workspace contracts and helpers for useAgent's
document, spreadsheet, presentation, and PDF workpieces. Pure TypeScript:
no React, no Node-only modules, no backend or provider code, and no
`@useagent/artifact-formats` dependency. The native byte rendering lives
in `@useagent/artifact-formats`, which depends on this package for the
shared MIME constants and workpiece state types.

This package is the canonical owner of:

- The MIME constants for the four rich workpiece kinds (`DOCX_CONTENT_TYPE`,
  `XLSX_CONTENT_TYPE`, `PPTX_CONTENT_TYPE`, `PDF_CONTENT_TYPE`) and the
  size bounds (`MAX_WORKPIECE_STATE_BYTES`, `MAX_RICH_WORKPIECE_SOURCE_BYTES`).
- The `ArtifactWorkpieceKind` discriminant (`document` | `spreadsheet` |
  `presentation` | `pdf`) and the matching `ArtifactWorkpieceState` shapes
  each kind accepts as canonical.
- The authoring profiles (`ARTIFACT_AUTHORING_PROFILES`,
  `artifactAuthoringProfile`) that pair each kind with a label, default
  file name, companion extension, native export list, and a
  `defaultState(name)` factory.
- The capabilities query (`artifactCapabilitiesFor`,
  `artifactActionContractFor`) that maps an artifact descriptor to its
  preview renderer, edit contract, and available actions.
- The fidelity table (`ARTIFACT_FIDELITY`, `artifactFidelityFor`) that
  states, in plain language, what each kind's editor preserves and what
  it deliberately drops, plus an `importNote` for uploads.
- The surface classifier (`artifactSurfaceCategoryFor`) that places an
  artifact into the `files` / `docs` / `media` buckets the UI renders.
- The state guards (`isArtifactWorkpieceState`) that distinguish
  canonical v2 state from legacy v1 inputs, so callers can upgrade on
  load instead of accepting stale shapes as canonical.

## What is not here

- No tenant, user, run, or artifact database access.
- No browser UI; the editor that consumes these contracts lives in the
  frontend app.
- No native format byte rendering; that is `@useagent/artifact-formats`,
  which imports the MIME constants and state types from here.

## Companion vs. authored vs. unsupported

Each kind's `ArtifactFidelity.uploadImport` says, in one word, how honest
the upload path is:

- `companion` — a bounded text/CSV/slide-JSON projection is imported; the
  original is kept downloadable.
- `authored` — state is authored in the browser and rendered to native
  bytes.
- `unsupported` — no importer yet; the original stays download-only.

Both the product UI and the public API render these exact strings, so a
user is never told a canonical companion is a rich binary round-trip.

## Verification

Run from this package:

```sh
bun test
bunx tsc --noEmit
```

The test suite covers the boundary cases of state coercion
(`test/boundary.test.ts`), the capabilities query
(`test/capabilities.test.ts`), and each workpiece kind's normalize and
migrate paths (`test/document.test.ts`, `test/presentation.test.ts`,
`test/spreadsheet.test.ts`, `test/formula.test.ts`).
