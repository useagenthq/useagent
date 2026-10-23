# @useagent/artifact-workspace

The browser-safe artifact core for useAgent's document workspace. It owns the
artifact MIME constants, workpiece kinds, CSV handling, the in-browser
spreadsheet formula engine, and slide/document normalization used by the
frontend, backend and two packages.

This is the canonical owner of the artifact MIME constants and workpiece state
types. `artifact-formats` imports them from here and re-exports them; this
package owns the constants, not the native format conversion.

`private: true`. No build step - raw TypeScript is consumed directly via the
`file:` links in each app's `package.json`.

## What it owns

- **Workpiece kinds & MIME constants** (`src/index.ts`): `CONTENT_TYPES` maps
  file extensions (`.csv`, `.docx`, `.pdf`, `.pptx`, `.xlsx`, `.html`, images,
  video, ...) to MIME types, alongside `INLINE_PREVIEW_CONTENT_TYPES` and the
  `ArtifactWorkspaceKind` union (`document` | `spreadsheet` | `presentation` |
  `pdf` | `media` | `html` | `svg` | `binary`), plus the surface-category and
  preview-renderer vocabulary.
- **CSV** (`src/csv.ts`): `csvToWorkbook` and `normalizeWorkbook`.
- **Spreadsheet formula engine** (`src/formula.ts`): a bounded, dependency-free
  formula engine - see [Formula support](#formula-support).
- **Document** (`src/document.ts`): `coerceDocumentState`, `normalizeDocument`.
- **Presentation** (`src/presentation.ts`): `migrateSlidesToDeck`,
  `normalizeDeck`.
- **Rich HTML** (`src/rich-html.ts`).

## Exports

The package barrel re-exports every module: `contracts`, `csv`, `document`,
`formula`, `presentation`, `rich-html`, `spreadsheet`. Apps import the
TypeScript source directly through the `@useagent/artifact-workspace`
specifier.

## Who imports it

`frontend`, `backend`, `agent-client`, and `artifact-formats`.

## Formula support

`src/formula.ts` is a bounded, dependency-free spreadsheet formula engine that
evaluates a workbook on the client at render/edit time. It supports:

- arithmetic (`+ - * /`), cell refs, ranges, and comparisons;
- `SUM`, `AVG`/`AVERAGE`, `MIN`, `MAX`, `COUNT`, `IF`;
- cross-sheet refs (`Sheet2!A1`).

Error values: `#REF!`, `#CYCLE!`, `#DIV/0!`, `#NAME?`, `#VALUE!`, `#ERR!`.
Cycles yield `#CYCLE!`, bad refs `#REF!`, division by zero `#DIV/0!`. The engine
is pure - no I/O, no DOM - and `VLOOKUP` is deliberately **not** shipped; the
supported set is intentionally small so it can be exhaustively tested.

## Boundary rule

`test/boundary.test.ts` enforces that the package stays **dependency-free and
runtime-neutral**:

- `package.json` must define no `dependencies`;
- `tsconfig.json` must set `"lib": ["ESNext"]`;
- the source must not import from `node:`, `react`, `next/`, `@/`, or
  `../../backend`.

## Verification

Run from this package (the commands used across all packages):

```sh
bun test
bunx tsc --noEmit
```

The package scripts wrap the same commands: `bun run test` and
`bun run typecheck`.
