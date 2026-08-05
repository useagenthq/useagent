# opencode web app — vendored build (the "Live" tab)

opencode's own web UI (SolidJS SPA, MIT — `anomalyco/opencode`, `packages/app`),
built to static assets and skinned to skynet-a's warm dark ladder. Rendered in an
iframe by `components/chat/live-pane.tsx` for opencode-engine threads. It talks to
the thread's live `opencode serve` (in its Daytona sandbox) through the same-origin
backend bridge at `/api/live-proxy/<threadId>` (`backend/src/runs/live-proxy.ts`).

**This directory is a build artifact — do not hand-edit `assets/` or `index.html`.**
Regenerate with the steps below.

## How the embed reaches its server (the one non-obvious patch)

opencode's client builds every request as `new URL(descriptor.path, baseUrl)`. An
absolute path (`/api/event`) resolves against the *origin*, discarding any base
*path* — so a plain `baseUrl = /api/live-proxy/<id>` cannot work. Instead the app
is pointed at a sentinel **origin** and a `fetch` shim rewrites requests to that
origin onto our same-origin proxy prefix, preserving the full opencode path as a
suffix. Activated by the `?api=/api/live-proxy/<threadId>` query param the iframe
passes. Both `/api/*` and bare/`/global/*` opencode routes pass straight through.

## Rebuild

1. Clone `anomalyco/opencode` (branch `dev`) and `bun install` at its repo root
   (bun workspaces + catalog; ~4.7k pkgs).
2. Apply the entry patch to `packages/app/src/entry.tsx` (verbatim, right after the
   `DEFAULT_SERVER_URL_KEY` const), and add `if (OC_PROXY_BASE) return OC_PROXY_SENTINEL`
   as the first line of both `getCurrentUrl()` and `getDefaultUrl()`:

   ```ts
   const OC_PROXY_SENTINEL = "https://opencode-proxy.skynet.internal"
   const readProxyBase = () => {
     if (typeof location === "undefined") return null
     const raw = new URLSearchParams(location.search).get("api")
     if (!raw || !raw.startsWith("/")) return null
     return raw.replace(/\/+$/, "")
   }
   const OC_PROXY_BASE = readProxyBase()
   if (OC_PROXY_BASE && typeof window !== "undefined") {
     const realFetch = window.fetch.bind(window)
     window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
       const href = typeof input === "string" ? input : input instanceof Request ? input.url : String(input)
       if (href.startsWith(OC_PROXY_SENTINEL)) {
         const u = new URL(href)
         const rewritten = `${location.origin}${OC_PROXY_BASE}${u.pathname}${u.search}`
         if (input instanceof Request) return realFetch(new Request(rewritten, input), init)
         return realFetch(rewritten, init)
       }
       return realFetch(input, init)
     }
   }
   ```

   The shim is inert without `?api=`, so it never affects opencode's own deploys.

3. Build with our base path:
   `cd packages/app && bunx vite build --base=/opencode-app/`
4. Copy `dist/` here, dropping sourcemaps and the Cloudflare `_headers`:
   `rsync -a --exclude='*.map' --exclude='_headers' dist/ <this-dir>/`
5. Re-apply the two hand-edits to `index.html` (they are NOT produced by the build):
   - after the `oc-theme-preload.js` script, a small inline script forcing dark:
     `document.documentElement.dataset.colorScheme = "dark"` + the matching
     `localStorage.setItem("opencode-color-scheme","dark")`.
   - before `</head>`, `<link rel="stylesheet" href="/opencode-app/skynet-theme.css" />`.

## Theming — `skynet-theme.css`

opencode derives every dark surface from a grey ramp (`--v2-grey-1200` deepest …
`--v2-grey-700` raised+). `skynet-theme.css` re-anchors that ramp on
`html[data-color-scheme="dark"]` (higher specificity than the app's own rule), so
the whole surface ladder recolours to our tokens at once — canvas `#20201f`, cards
`#292826`, raised `#3b3935`, raised+ `#4b4944`. Text greys and accent hues are left
as shipped. Font is already Inter upstream. Best-effort skin (base/background/font).
