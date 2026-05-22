# @skynet/artifact-formats

Native artifact conversion helpers for Skynet's document workspace.

This package owns format-specific byte rendering and bounded text extraction for
browser-authored workpieces. It is deliberately separate from the backend
control plane and frontend editor state so every runtime uses the same
DOCX/XLSX/PPTX/PDF behavior.

Artifact MIME constants and workpiece state types are imported from and
re-exported through the internal `@skynet/artifact-workspace` dependency. That
browser-safe package is the canonical owner; this package only owns native
format conversion.

`renderArtifactExport` is the sole public rendering entry point; format-specific
render helpers remain internal implementation details. `buildArtifactBundle`
packages multiple artifacts' bytes into a single ZIP (colliding names are
disambiguated) for run-level "download all".

## Current Contract

| Format | Create/export | Import/extract | Notes |
|---|---:|---:|---|
| DOCX | Yes | Text only | Rich-HTML document companions render real DOCX structure (headings, bold/italic/underline, ordered and bulleted lists, hyperlinks, tables); plain-text state renders markdown-style paragraphs. Extraction returns raw text. |
| XLSX | Yes | CSV only | Renders and extracts the first worksheet as CSV. |
| PPTX | Yes | Slide text only | Renders title/body slides and extracts slide text. |
| PDF | Yes | No | Renders readable text PDFs; uploaded PDF extraction and page operations are not claimed yet (state is text-only). |
| HTML, text, CSV, JSON | Yes | N/A | Canonical companion formats for browser previews and fallback export. |
| ZIP bundle | Yes | N/A | `buildArtifactBundle` packages many artifacts into one archive. |

## Non-Goals

- No tenant, user, run, or artifact database access.
- No rich Office roundtrip claims. Rich formatting remains a future adapter.
- No browser UI code.

## Verification

Run from this package:

```sh
bun test
bunx tsc --noEmit
```
