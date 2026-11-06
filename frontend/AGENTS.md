# frontend - agent guide

The UseAgent web app: Next.js 16 (App Router, Turbopack), React 19, TypeScript,
Tailwind CSS 4, on bun. `CLAUDE.md` imports this file; edit here. Root rules:
[../AGENTS.md](../AGENTS.md). Type, radius and borders:
[DESIGN-RAMP.md](components/foundations/DESIGN-RAMP.md).

## Density and type, most violated first

1. The density is intentional. Never add padding, gaps or "breathing room", or
   size text up, in a feature, a port or a review: polish inside the density.
2. Measured in the session lab (`/lab/session`) at 100% zoom, new UI matches:
   body 13px, work-log labels 12.5px, mono 11 to 11.5px, captions 12px, chrome
   (sidebar, tabs, header) 14px.
3. Text sizes come from the type tokens in `styles/typography.css`:
   `text-caption-1-*` 12/16, `text-body-2-*` 13/18, `text-body-*` 14/20, and
   24px for a page title (`text-title-1-*`, or `text-display-sm` for a hero).
   Always with a weight (`text-body-2-regular`): a bare `text-body-2` is no
   utility and renders at the inherited size ("typography utilities exist" in
   `components/foundations/ratchet.test.ts`). Never an arbitrary `text-[Npx]`
   class or an inline UI font size: the "arbitrary font-size ratchet" there
   holds today's class debt (the work log's `text-[11.5px]` and others) and
   only shrinks; move those sizes onto tokens, never treat them as precedent.
4. Popovers, menus, dropdowns, selects and tooltips use the dense sizes: rows
   at `text-body-2-*`, meta at `text-caption-1-*`, never `text-body-*`. Check
   the opened portal, not the trigger's classes.
5. A port from any library is adapted to our tokens, density and icons; the
   upstream demo's sizes and spacing never come along.
6. Lab pages render inside the app's own root layout, fonts, theme and density;
   give a lab page no scale, zoom or wrapper of its own, so its preview is what
   ships.
7. Before calling UI done, screenshot it at 100% zoom next to an existing app
   surface with the same role (a menu beside a menu, a row beside a row), in
   dark and light, and compare size, weight, spacing and color. Check computed
   styles in the browser, popovers included.
8. Quiet chrome: section labels in sentence-case sans (`text-mono-label` is a
   historical name), never uppercase tracked overlines; nav and rail icons in
   one grey (`text-text-secondary`); a selected row is the hover surface
   (`bg-background-secondary-hover`) with `text-text-primary`, never an accent
   fill; chips stay at their default
   caption variant beside dense text.

## Tokens and themes

- The live tokens are BoardUI's `styles/theme.css` (color, radius, shadow) and
  `styles/typography.css` (type), imported by `app/globals.css`. Use the
  semantic utilities; the surface ladder (`bg-background-full` page,
  `bg-background-primary-default` panels and so on, hairlines, text) is in
  `DESIGN-RAMP.md` section 4. Never raw hex, never `dark:` (a theme class swaps
  the variables).
- `tailwind.config.ts` is the legacy AlignUI-starter scale (`title-h*`,
  `label-*`, `paragraph-*`, `subheading-*`) and its color names; old code still
  uses them, new code does not. Keep its `@config` line in `app/globals.css`.
- Theme tokens are authoritative for surfaces, borders and elevation;
  `DESIGN-RAMP.md` holds the defaults once. A theme may override radius, stroke,
  shadow and heading weight through its tokens and its overlay rules in
  `app/globals.css` (Neobrutal does); never hard-code a default to defeat one.
- Twelve themes, dark (`dark`, labelled Midnight) by default, light achromatic.
  A theme touches: `app/providers.tsx` (`themes`),
  `components/shell/theme-menu.tsx` (`THEME_OPTIONS`, with its test),
  `app/globals.css` (its ramp, overlay and swatch), `components/base/thinking-orb/theme.ts`,
  `components/prompt-kit/mermaid-diagram.tsx`, and
  `components/foundations/theme-tokens.test.ts`, which requires every dark
  overlay to define the same keys as `.dusk` (or it falls back to light values).
- Contrast: text AA on its own surface or tint, icons at least 3:1; pin a new
  pairing numerically in `theme-tokens.test.ts`.
- Matching a reference design or library: read its real source (tokens,
  component recipes) first; never rebuild it from memory.
- Fonts load in `app/layout.tsx`: Inter (UI), Inter Tight (display), JetBrains
  Mono (code). Do not change them on your own.

## Motion and interaction

Principles from [animations.dev](https://animations.dev/) (Emil Kowalski),
[Invisible Details](https://invisibledetails.com/) and
[UI Skills](https://www.ui-skills.com/) (MIT), in our words:

- Animate only `transform` and `opacity`; never width, height, position,
  padding or font size.
- One curve: `EASE_OUT` in `lib/motion.ts`, ease-out on enter. UI motion stays
  under about 300 ms and interaction feedback under 200 ms; springs are for
  drag and gesture-driven motion.
- Do not animate what the keyboard or a frequent action triggers (command
  palette, sidebar toggle, tab switches); restraint is part of the design.
- Popovers scale from their trigger (`transform-origin`), from 0.95, never 0.
- Reduced motion: `MotionConfig reducedMotion="user"` in `app/providers.tsx`
  covers motion/react; CSS motion must degrade under `prefers-reduced-motion`.
- Interaction details: pressed controls give feedback, tooltips wait before
  the first open, focus rings show on keyboard focus, icons are optically
  aligned, hit areas stay usable on touch, numbers use `tabular-nums`.

## Copy and honesty

- The brand is written UseAgent in every user-visible string; stored and
  protocol identifiers keep their spelling. Never the product's former name
  (the backend's product-name ratchet) in UI, demos or screenshots.
- No em dashes in strings (ratchet "em-dash ratchet (frontend)").
- No fake numbers or states: show real data, or an empty state. "Delivered",
  "Published" and the like need the evidence.
- A ported component's strings are ours: rewrite another product's vocabulary
  and slogans.
- Build new UI in `/lab` with real-shaped fixtures first, get it right there,
  then wire it; a control without a handler does not ship.

## Reuse before you build

Search the code and `/lab` first. The kit and its homes:

- `components/base/` the canonical kit (BoardUI free edition, MIT): Button, Chip,
  Input, Select, Tabs, Modal, Drawer, Tooltip and more. New primitives go here.
- `components/session-ui/` the session timeline and sidebar grammar,
  `components/chat/` the conversation (thread store, streams, composer,
  timeline, panes), `components/ai/` AI primitives (loading, thinking,
  streaming, approval card, tool chips, tables), `components/agent-ui/` agent
  activity and approvals.
- `components/shell/` the app shell, sidebars, ⌘K search, theme menu;
  `components/sidebar-kit/` the bounded shadcn sidebar exception (its README);
  `components/application/` app-level blocks; `components/pro/` the composer
  panel, model picker, status and usage components.
- Seams: `lib/backend-fetch.ts` (`backendFetch`) for every backend call;
  `components/chat/use-thread-stream.ts` and
  `components/chat/thread-store.ts` for a thread;
  `components/base/overlay-portal-container.ts` for overlays inside modals;
  `cx` (`utils/cx.ts`, merge) and `tv` (`utils/tv.ts`); icons from
  `@remixicon/react`; motion from `motion/react`; the brand mark
  `components/foundations/brand/orbit-knot-mark.tsx`.
- Native approvals, questions, child turns, cancel and reconnect render through
  the shared session components for every engine; never a per-engine copy.
  Engine pickers and engine-specific UI read `GET /api/config` engines and
  capability flags, never `engine === "..."`. Every human approval (gateway and
  provider-native) renders through one card, `components/ai/approval-card.tsx`,
  which owns the presentation, focus and Escape / Cmd-Enter shortcuts; the lane
  wrappers `components/chat/gateway-approval-card.tsx` and
  `components/chat/native-approval-card.tsx` own their decision semantics, never
  a second layout.
- A thread has one stream: the thread-scoped events endpoint through
  `use-thread-stream.ts` into the shared store and timeline builder. Never a
  second reducer, stream controller or poll.
- `vendor/` holds pinned upstream snapshots for reading only; nothing imports
  from it. Name by function, credit by header; never recreate a kit directory
  such as `components/ui` (ratchet).

## Performance

Real threads are big (hundreds of steps, a megabyte of frames). Keep:

- Bounded DOM: long timelines window (`components/chat/turn-window.tsx`) or fold;
  rows are keyed and memoized.
- No O(n) work per streamed item: apply an SSE burst in one `ThreadStore.batch`
  per frame; ingest returns whether anything changed; derived snapshots are
  cached and invalidated, never rebuilt on read.
- Hidden content mounts only when opened.
- Measure on a real heavy thread before claiming a fix: `bun run perf:routes`
  after `bun run build` reports each route's first-load JS, `bun run analyze`
  shows what a route pulls in, and `test/perf/` holds the measurement scripts.

## Commands

- `bun run dev` (port 3400), `bun run local` (dev against a remote API),
  `bun run build`, `bun run start`.
- `bun run typecheck`, `bun run lint` (Biome), `bun run test`
  (`bun test components app lib`).
- A changed package is seen only after `bun install --frozen-lockfile` here
  (bun copies `file:` packages).
- `USEAGENT_API_ORIGIN` is baked into a build's `/api` rewrite (`next.config.ts`): set it before
  `bun run build`. `proxy.ts` only checks that a session cookie exists; the
  backend authorizes. A preview login bypass stays gated to non-production.
- A stale `next dev` or `next start` serves old chunks: stop yours by its port
  (`lsof -ti:<port>`) before suspecting a regression.
- Run `biome check --write` only on files you created (it reformats whole
  files); keep `app/error.tsx` and `app/not-found.tsx` imports minimal (they
  load on every route).

## Before you say done

1. Root `bun run typecheck`, then `bun run test`, `bun run lint` and
   `bun run build` here pass; ratchets pass without a raised baseline.
2. Density: the 100% zoom screenshot beside a same-role surface matches; type
   classes are tokens with weights; popovers use the dense sizes.
3. Dark and light (and any theme you touched) checked; motion is transform and
   opacity only and honours reduced motion.
4. The change works in a production build with a signed-in user on real-shaped
   data: the action, its backend result and a reload.
5. Copy says UseAgent, no em dash, no invented number.

## Review prompt

```
Review the pull request's diff against frontend/AGENTS.md. Check: density kept (no added
padding, no upsized text); type only through text-caption-1-*, text-body-2-*, text-body-*
with weights, no arbitrary text-[Npx]; popovers, menus and dropdowns at body-2/caption;
ports adapted to our tokens and density; semantic tokens only, no raw hex or dark:,
themes not defeated; motion transform and opacity only, ease-out, under 300 ms, reduced
motion honoured, nothing animated on keyboard actions; an existing component reused
instead of a near-duplicate; UseAgent copy, no em dash, no fake data; every control has a
handler; no O(n) work per streamed item. P1 = broken flow, lost data, a duplicated
primitive, or a density or type regression on a shipped surface. End with
VERDICT: APPROVE or VERDICT: CHANGES.
```
