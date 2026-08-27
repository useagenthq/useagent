# useAgent frontend - agent guide

**useAgent** is an open-source agent platform: autonomous engineers running
in isolated cloud sandboxes. The canonical UI kit is `components/base/**` (BoardUI-derived,
licensed and vendored) plus its semantic tokens; every product surface builds on
it. Dialog/overlay primitives (Modal, Drawer, command palette) live in
`components/base` and `components/session-ui`. Chat surfaces compose
**prompt-kit** primitives (`components/prompt-kit/**`).

Canonical guide for ALL coding agents working in this repo. `CLAUDE.md` imports
this file (`@AGENTS.md`); edit here, never fork the content.

Layer map (canonical paths):
- **foundation**: `components/base/**` (canonical BoardUI-derived kit) plus its
  semantic tokens, and `components/foundations/**` (brand). Tokens + motion
  utilities live in `app/globals.css`.
- **app shell** - `components/shell/**` (AppShell, ThreadSidebar,
  LibrarySidebar, search-command ⌘K, user-menu, theme-toggle).
- **chat surface** — `components/chat/**` (vendored prompt-kit + composer +
  session panes).
- **AI kit** — `components/ai/**` (beautiful-ui ports; see its README).
  Note: `components/ai/approval-card.tsx` is vendored and READY but currently
  unused by design — engines run one-shot in yolo mode, so nothing can pause a
  run for approval yet. The old mock usage in `conversation.tsx` was removed as
  misleading; compose the card again when a real backend approval flow lands.
- **pages** — `app/**` routes, page-specific components colocated per route.

## Stack

- **Next.js 16** (App Router, **Turbopack**) + **React 19** + **TypeScript**.
- **Tailwind CSS v4** (CSS-first, via `@tailwindcss/postcss`).
- **bun** for everything (`bun install`, `bun run …`, `bunx …`).
- Fonts: **Inter Tight** (`--font-display`) for page-level display headings,
  **Inter** (`--font-sans`) for product UI, and **JetBrains Mono** (`--font-mono`)
  for code and technical metadata. All load through `next/font/google` in
  `app/layout.tsx`.
- Theme: **dark by default** on first load (the reference screenshots are dark);
  light is available via the toggle. Class strategy on `<html>` (`next-themes`,
  `attribute="class"`, `defaultTheme="dark"`). See the ladder section below.

> Next 16 has real breaking changes vs older versions (async request APIs, config
> shape). When unsure, read `node_modules/next/dist/docs/`.

## Commands

- `bun run dev` — dev server on **http://localhost:3400**
- `bun run typecheck` — `tsc --noEmit` (keep it clean)
- `bun run build` — production build

## Directory layout

```
app/                      # App Router routes + globals.css + layout/providers
components/
  base/                   # ← canonical BoardUI-derived kit (compose it; new UI here)
  foundations/brand/      # AsteriskMark brand glyph (single source)
  application/**          # app shell + page-specific components  (shell agent)
  chat/**                 # prompt-kit chat surface                (chat agent)
utils/                    # cn / cx / tv / polymorphic helpers
hooks/                    # use-tab-observer, use-breakpoint
tailwind.config.ts        # semantic token scale (bridged into v4 via @config)
app/globals.css           # Tailwind entry + tokens + brand/motion utilities
```

## Dialog / overlay primitives

Modal, Drawer, and the ⌘K command palette are the app's overlay primitives.
They are built on `@radix-ui/react-dialog` (portal, focus-trap, Esc-to-close,
scroll-lock, backdrop dismiss) and styled with base-kit semantic tokens:

- `components/base/modal/modal.tsx` — compound `Modal.Root / Trigger / Content /
  Header / Title / Description / Body / Footer / Close`. Controlled via
  `Root open onOpenChange`, or opened from a `Trigger`; callers restyle the
  panel via `Content`'s `className`.
- `components/base/drawer/drawer.tsx` — right-side sheet, same compound shape.
- `components/base/textarea/textarea.tsx` — `Textarea.Root` form control (no
  base-kit textarea twin exists).
- `components/session-ui/command-palette.tsx` — cmdk-based palette backing the
  ⌘K search command.

Everything else composes `components/base/**` directly: `Button`, `Chip`,
`Input`, `Select`, `Switch`, `Checkbox`, `Tabs`, `SegmentedControl`, `Avatar`,
`Table`, `Tooltip`, and friends. These are react-aria based (props, not
namespace exports) — e.g. `<Button variant="primary" leadingIcon={RiAddLine}>`,
`<Chip color="blue">Queued</Chip>`, `<Input leadingIcon={RiSearch2Line} />`.

## Token rules (semantic, never raw hex, never `dark:`)

Theming works by the `.dark` class swapping CSS variables — components reference
**semantic tokens** and flip automatically. **Never write `dark:` prefixes.**

- Surfaces: `bg-bg-white-0`, `bg-bg-weak-50`, `bg-bg-soft-200`, `bg-bg-sub-300`,
  `bg-bg-surface-800`, `bg-bg-strong-950`.
- Text: `text-text-strong-950`, `text-text-sub-600`, `text-text-soft-400`,
  `text-text-disabled-300`, `text-text-white-0`.
- Strokes/rings: `stroke`/`ring`/`border` + `-stroke-soft-200` / `-stroke-sub-300`
  / `-stroke-strong-950`.
- Brand + state: `primary-*` (`bg-primary-base`, `text-primary-base`,
  `primary-alpha-10`), plus `information` / `warning` / `error` / `success` /
  `away` / `feature` / `verified` / `highlighted` / `stable` (each with
  `-base` / `-light` / `-lighter` / `-dark`). Raw palettes `blue`/`red`/`green`/…
  (`50`–`950`, `alpha-10/16/24`) also exist.
- Typography scale (font-size + tracking baked in): `text-title-h1…h6`,
  `text-label-xl…xs`, `text-paragraph-xl…xs`, `text-subheading-md…2xs`.
- Radii: `rounded-10` (.625rem), `rounded-20` (1.25rem) — plus stock Tailwind.
- Shadows: `shadow-regular-xs/sm/md`, `shadow-tooltip`, `shadow-switch-thumb`,
  `shadow-button-primary-focus`, `shadow-fancy-buttons-*`, …

Full source of truth: `tailwind.config.ts` (token scale) + `app/globals.css`
(the CSS-variable definitions for `:root` and `.dark`).

Exception: brand icon tiles / the AsteriskMark may use `currentColor` freely.

## Default dark theme - achromatic graphite

**Dark is the default theme.** Its surface and text ramp is achromatic
graphite: the page backdrop is `#121212`, panels/cards are `#262626`,
chrome/insets are `#171717`, raised surfaces are `#2e2e2e`, primary text is
`#fafafa`, muted text is `#a1a1a1`, and borders are `#333333`. The interactive
accent remains blue. The light theme is independent and uses warm neutrals:
canvas `#faf9f6`, panel fill `#f5f4f1`, and hairlines `#eae8e4`. Components
consume the semantic tokens below and never hard-code theme values.

Use these tokens for the elevation ladder (dark values shown; they invert
correctly in light):

| Role | Token (utility) | Dark value |
|------|-----------------|-----------|
| Page backdrop | `background-full` | `#121212` |
| Panel / card | `bg-bg-white-0` | `#262626` |
| Chrome / inset | `bg-bg-weak-50` / `bg-bg-soft-200` | `#171717` |
| Raised / active | `bg-bg-sub-300` | `#2e2e2e` |
| Hairline border | `border`/`ring`/`stroke` + `-stroke-soft-200` | `#333333` |
| Stronger border | `...-stroke-sub-300` | `#404040` |
| Primary text | `text-text-strong-950` | `#fafafa` |
| Secondary text | `text-text-sub-600` | `#a1a1a1` |
| Muted text | `text-text-soft-400` | `#737373` |
| Modal / command palette scrim | `bg-overlay` | `#0f0f0f` @ 72% |

Rules for the four sibling page agents:
- Sidebar, top nav, cards, command-palette backdrop, and tables all read from
  the tokens above.
- Page backdrops use `background-full`; panels/cards use `bg-bg-white-0`;
  chrome and inset fills use `bg-bg-weak-50` / `bg-bg-soft-200`; raised and
  active surfaces use `bg-bg-sub-300`. Separate with `border-stroke-soft-200`,
  not shadows.
- Keep the warm light-mode neutrals independent when adjusting the dark ramp.
- The `<html>` element also carries `bg-bg-white-0`, so overscroll never flashes
  black/white.

## Brand + motion utilities (`app/globals.css`)

- `text-mono-label` — uppercase tracked monospace micro-label (section labels,
  rail captions, technical annotations). Uses `--font-mono`.
- `bg-halftone` — faint halftone dot field, masked to fade downward; for brand
  headers/heroes.
- `.animate-ai-fade-up` — soft rise-in on mount (panels, approval cards).
- `.ai-caret` — blinking terminal cursor tailing streaming text.
- `.ai-loading-pixel` — staggered opacity pulse for dot-matrix loaders (set a
  per-dot `style={{ animationDelay }}`).
- `.agent-progress-loading-text` — shimmer sweep for streaming status labels.

All motion degrades under `prefers-reduced-motion: reduce`. For component-level
animation use **`motion/react`** (the `motion` package is installed):
`import { motion } from 'motion/react'`.

## Brand mark

`import { AsteriskMark } from '@/components/foundations/brand/asterisk-mark'`
is the single source for useAgent's ✳ glyph. Size/color come from `className`.
Never inline a copy.

## Utilities (`utils/`)

- `cn(...)` — `clsx` only (no conflict resolution). Use for static class lists.
- `cx(...)` — `tailwind-merge` conflict resolution. Use when a later class (e.g.
  a `className` prop) must override an earlier one.
- `tv(...)` — preconfigured `tailwind-variants` for component variant maps.
- `polymorphic` + `recursive-clone-children` — internal helpers for the `as`
  prop + shared-prop propagation.

## Conventions

- Server components by default; add `"use client"` only at the interactive leaf.
  Do not pass component/function props (icons included) across the server→client
  boundary — keep the boundary at the component that owns them.
- Icons: `@remixicon/react` only.
- Reuse the vendored kit and brand utilities before writing new primitives.
- User-visible strings say **"useAgent"**, never the template name.
- Do not remove the `@config '../tailwind.config.ts';` line from
  `app/globals.css` — it is what makes every semantic token resolve.
- `AGENTS.md` is hand-maintained; `agentRules: false` in `next.config.ts` stops
  Next from regenerating it.

## Naming (vendored code)

Name by FUNCTION, attribute by HEADER. Vendored/adapted components never carry
the source product's name in identifiers, paths, or data attributes - the
MIT/source notice in the file header is the attribution. The vendored UI layer
is `components/session-ui/` (neutral names like `WorkEntryRow`, `ThreadRow`);
`data-session-ui` is its DOM marker. Product names are allowed only where code
speaks that product's real wire protocol (backend adapters).

## String style
- No em dashes ("—") in code: user-visible strings, labels, placeholders, aria text, and HTML/JSX element text use plain hyphens or restructured sentences instead.

## Performance (this is a serious product — treat perf as a feature, not a nicety)

Real runs get BIG: one settled session here had 131 steps + 463 native frames
(~1MB) and, rendered naively, froze the tab for 3-4 minutes. The data volume is a
given; the render must stay cheap. Rules learned the hard way (do NOT regress):

- **Never render an unbounded list at O(n) DOM cost.** For long timelines/lists,
  fold (collapsed disclosures) AND/OR virtualize (`@tanstack/react-virtual`). Rows
  are `memo`'d and keyed so React reconciles only what changed.
- **Never do O(n) work per streamed item — that is O(n²) across a burst.** A
  settled-run SSE replay delivers hundreds of frames back-to-back. Two traps we
  hit: (1) notifying the store per frame → a full re-render + timeline rebuild each
  time; fixed by `ThreadStore.batch(fn)` (coalesce a burst into ONE flush) + the
  hook buffering SSE frames and applying each burst in one batch per animation
  frame (opencode-style "apply the burst, paint once"). (2) rebuilding a derived
  snapshot just to detect change (`getSnapshot() !== before`) → O(n) per item;
  fixed by ingest/reducer methods RETURNING a `changed` boolean so callers never
  rebuild in the hot path. Prefer both patterns for any high-frequency store.
- **Lazy-render heavy/hidden content.** Collapsed disclosures render their children
  only when expanded (`expandable && open && ...`), so a 33KB tool payload never
  hits the initial DOM. Do not eagerly render what is behind a fold.
- **Derived views are cached + invalidated, never rebuilt on every read.** Stores
  hold `snapshot: T | null`, rebuild lazily in `getSnapshot`, and null it on
  mutation — React re-reads after a render, so no eager recompute.
- **Measure before claiming a fix.** Reproduce on the real heavy case (a giant
  run), profile the main-thread block, and verify in the browser (loads fast AND
  scrolls). "Works on a 5-step run" proves nothing about the 500-step run.
- Learn the rendering approach from opencode (fine-grained reactivity, batched
  events) before hand-rolling — we own the React port, so we replicate their
  behavior with memo + batching + virtualization.
# Execution discipline

- Think before coding: name material assumptions and competing interpretations. If uncertainty would change behavior or scope, stop and resolve it instead of silently guessing.
- Simplicity first: add no unrequested feature, configurability, single-use abstraction, or defensive branch for an impossible condition. If a substantially smaller clear solution satisfies the same contract, use it.
- Surgical changes: touch only what the task requires and match the local style. Do not clean unrelated debt; remove only the dead code or imports your change creates. Every changed line should trace to the requested outcome.
- Goal-driven execution: define observable success criteria and the checks that prove them before editing. Keep iterating until those checks pass or report the exact unresolved blocker.
- Tests must protect requested behavior or a concrete regression. Do not add generic source-shape assertions merely to increase test counts.
