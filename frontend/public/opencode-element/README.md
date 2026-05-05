# opencode session view — inline Web Component (`<skynet-oc-session>`)

opencode's own session view (SolidJS SPA, MIT — `anomalyco/opencode`,
`packages/app`), compiled to a **solid-element custom element** and rendered
**inline in our React app with no iframe**. Deep-links straight into one session
and talks to the thread's live `opencode serve` through the same-origin backend
bridge at `/api/live-proxy/<threadId>` (`backend/src/runs/live-proxy.ts`).

Rendered by `components/chat/live-inline.tsx` — a drop-in alternative to the
iframe `live-pane.tsx` with the same `{ threadId, sessionId }` props.

**This directory is a build artifact — do not hand-edit.** Regenerate below.

## Files

- `skynet-oc-session.js` — stable-named ESM entry (a 1-line facade importing the
  hashed bundle chunk). Load this; it registers the `<skynet-oc-session>` element.
- `skynet-oc-session.css` — the app's stylesheet (loaded once as a global
  `<link>`; the element renders into **light DOM**, so document styles apply).
- `skynet-element-*.js`, `*.js`, fonts, sprite — the hashed bundle + lazy chunks
  (shiki language grammars, ghostty-web wasm) fetched on demand under this base.

## How it renders inline (vs. the iframe build)

It reuses opencode's **entire** app bootstrap (`AppBaseProviders` + `AppInterface`
— the exact tree `entry.tsx` renders), because the session view is inseparable
from ~25 providers (server / sync / sdk / tabs / models / layout / permission /
terminal / …). The custom-element entry differs from `entry.tsx` only in:

- **config from element attributes**, not `?api=` / `location.hash`:
  `api="/api/live-proxy/<threadId>"` + `session-id="ses_…"`.
- **seeded in-memory router** (`MemoryRouter` with a pre-set history) so it boots
  straight into `/server/<base64url(sentinel)>/session/<id>` **without touching
  the host page's URL** — safe to embed inside our Next router.
- **light DOM** (`noShadowDOM()`) so the global stylesheet + the ThemeProvider's
  `:root` variables apply with no shadow-root style injection.
- reproduces the app's `#root` container (`flex flex-col h-dvh`) inside the
  element, since we render into the element, not `#root` — without it the
  timeline collapses to zero height.

Same server bridge as the iframe: the opencode client is pointed at a sentinel
origin (`https://opencode-proxy.skynet.internal`) and a `fetch` shim rewrites
those requests onto the `api` attribute's same-origin proxy prefix.

## Rebuild

Source lives in the opencode clone (`packages/app`). Two new files +
one dep + one vite config drive the element build; **no vendored source is
patched** (the element carries its own fetch shim, independent of the iframe
build's `entry.tsx` patch).

1. Clone `anomalyco/opencode` (branch `dev`) and `bun install` at repo root.
2. `cd packages/app && bun add solid-element`.
3. Add (from this repo's record):
   - `src/skynet-element.tsx` — registers `customElement("skynet-oc-session",
     { api, sessionId }, …)`, installs the proxy fetch shim, seeds the router.
   - `src/skynet-process-shim.ts` — sets a minimal browser `process` global.
     Vite **library** mode (unlike the app build) does not inline
     `process.env.NODE_ENV`, so browser deps that read `process.env.*` at runtime
     (notably `@tanstack/solid-query`) throw `process is not defined`. Imported
     first from the entry.
   - `vite.element.config.ts` — library build reusing the app's plugin stack
     (`./vite`: alias + Tailwind v4 + solid), `base:/opencode-element/`, a
     `define` inlining `process.env.NODE_ENV="production"`, single ESM + CSS out.
4. Build: `bunx vite build --config vite.element.config.ts`
5. Copy `dist-element/` here, dropping sourcemaps, and rename the CSS:
   `rsync -a --exclude='*.map' dist-element/ <this-dir>/ && \`
   `  mv <this-dir>/app.css <this-dir>/skynet-oc-session.css`

## Coupling / caveats (POC honesty)

- The whole opencode app shell (titlebar + tab strip) comes along with the
  session view — the deep-link boots into the session, but you also get its
  chrome. Narrowing to *only* the timeline would mean bypassing `NewAppLayout`
  while still hand-providing `LayoutProvider` + `ModelsProvider` (fragile).
- Bundle is heavy (single entry ~7.8 MB / ~3 MB gz + lazy shiki/wasm chunks);
  lazy chunks load on demand. Fine for a mounted-on-select tab; not committed.
- The fetch shim is installed globally, keyed to the most recent element's `api`
  — adequate for one live embed at a time (as the Live tab is).
- Internal `h-dvh` usages make the app viewport-tall; for a sub-viewport rail
  panel, swap the element wrapper to `h-full` and audit those usages.
