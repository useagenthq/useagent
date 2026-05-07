# skynet-a frontend — agent guide

**skynet-a** is an internal agent platform (same product family as
`skynet-saas`, a multi-repo autonomous engineer). This frontend is built on the
**AlignUI** design system + **prompt-kit** chat primitives — *not* BoardUI.

Canonical guide for ALL coding agents working in this repo. `CLAUDE.md` imports
this file (`@AGENTS.md`) — edit here, never fork the content.

Layer map (canonical paths):
- **foundation** — `components/ui/**` (vendored AlignUI), `components/foundations/**`
  (brand), tokens + motion utilities in `app/globals.css`.
- **app shell** — `components/shell/**` (AppShell, TopNav, ChatSidebar,
  AgentSidebar, search-command ⌘K, user-menu, theme-toggle).
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
- Font: **Inter** (`--font-sans`) + **JetBrains Mono** (`--font-mono`), both via
  `next/font/google` in `app/layout.tsx`.
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
  ui/                     # ← vendored AlignUI base kit (DO NOT MODIFY; compose it)
  foundations/brand/      # AsteriskMark brand glyph (single source)
  application/**          # app shell + page-specific components  (shell agent)
  chat/**                 # prompt-kit chat surface                (chat agent)
utils/                    # cn / cnExt / tv / polymorphic helpers
hooks/                    # use-tab-observer, use-breakpoint
tailwind.config.ts        # AlignUI token scale (bridged into v4 via @config)
app/globals.css           # Tailwind entry + tokens + brand/motion utilities
```

## AlignUI components (`components/ui/**`)

Vendored verbatim from the AlignUI Pro finance template. **Do not modify or
fork** — compose them. Every component uses **namespace exports** (`Root`,
plus `Icon` / `List` / `Trigger` / `Content` / `Item` / `Dot` / `Wrapper` …).

**Import convention — always `import * as X`:**

```tsx
import * as Button from '@/components/ui/button';
import * as Input from '@/components/ui/input';
import * as Badge from '@/components/ui/badge';
import * as Switch from '@/components/ui/switch';
import * as TabMenuHorizontal from '@/components/ui/tab-menu-horizontal';

<Button.Root variant="primary" mode="filled">
  <Button.Icon as={RiSparkling2Line} />
  New run
</Button.Root>

<Input.Root>
  <Input.Wrapper>
    <Input.Icon as={RiSearch2Line} />
    <Input.Input placeholder="Search…" />
  </Input.Wrapper>
</Input.Root>

<Badge.Root variant="light" color="blue">Queued</Badge.Root>
<Switch.Root defaultChecked />
```

`Button.Icon`, `Input.Icon`, `Badge.Icon`, `Tab*.Icon` take an `as={Icon}` prop
(a `@remixicon/react` component) rather than children.

**Available (all under `@/components/ui/<name>`):**
`alert`, `avatar`, `avatar-group`, `avatar-group-compact`, `avatar-empty-icons`,
`badge`, `button`, `button-group`, `checkbox`, `command-menu`, `compact-button`,
`digit-input`, `divider`, `dot-stepper`, `drawer`, `dropdown`, `fancy-button`,
`file-format-icon`, `hint`, `horizontal-stepper`, `input`, `kbd`, `label`,
`link-button`, `modal`, `pagination`, `popover`, `progress-bar`,
`progress-circle`, `radio`, `segmented-control`, `select`, `social-button`,
`status-badge`, `switch`, `tab-menu-horizontal`, `tab-menu-vertical`, `table`,
`tag`, `textarea`, `tooltip`, `vertical-stepper`.

Radix `TooltipProvider` is already mounted in `app/providers.tsx`, so tooltips
work anywhere without extra wiring.

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

## Dark theme — the #20201f ladder

**Dark is the default theme.** The whole app sits on a warm near-black base of
**`#20201f`** — no pure black, no blue-gray. This is implemented in the `.dark`
block of `app/globals.css` by re-anchoring the `neutral` ramp to a warm scale
(hue ~40–60°, very low saturation) with `neutral-950 = #20201f`. Because every
AlignUI semantic token derives from that ramp, **you get the ladder for free by
using the semantic tokens** — never hard-code a background/border in dark.

Use these tokens for the elevation ladder (dark values shown; they invert
correctly in light):

| Role | Token (utility) | Dark value |
|------|-----------------|-----------|
| Base page / canvas | `bg-bg-white-0` | `#20201f` |
| Card / panel / input / elevated | `bg-bg-weak-50` | `#292826` |
| Raised / hover / popover | `bg-bg-soft-200` | `#3b3935` |
| Raised+ / active | `bg-bg-sub-300` | `#4b4944` |
| Hairline border | `border`/`ring`/`stroke` + `-stroke-soft-200` | `#3b3935` |
| Stronger border | `…-stroke-sub-300` | `#4b4944` |
| Primary text | `text-text-strong-950` | `#ffffff` |
| Secondary text | `text-text-sub-600` | `#99968f` |
| Muted text | `text-text-soft-400` | `#75726c` |
| Modal / ⌘K palette scrim | `bg-overlay` | warm near-black @ 60% |

Rules for the four sibling page agents:
- Sidebar, top nav, cards, command-palette backdrop, tables — **all** read from
  the tokens above. If a surface looks pure-black or blue-gray in dark, you used
  a raw color instead of a token.
- Base surfaces = `bg-bg-white-0`; lift one step (`bg-bg-weak-50`) for cards, a
  second step (`bg-bg-soft-200`) for menus/hover. Separate with
  `border-stroke-soft-200`, not shadows.
- Don't touch the light-mode neutrals — the warm ramp is scoped to `.dark` only.
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
— the single source for Skynet's ✳ glyph. Size/color come from `className`.
Never inline a copy.

## Utilities (`utils/`)

- `cn(...)` — `clsx` only (no conflict resolution). Use for static class lists.
- `cnExt(...)` — `clsx` + `tailwind-merge` (AlignUI-aware). Use when classes may
  conflict / be overridden by a `className` prop.
- `tv(...)` — preconfigured `tailwind-variants` for component variant maps.
- `polymorphic` + `recursive-clone-children` — internal helpers for the `as`
  prop + shared-prop propagation the AlignUI components rely on.

## Conventions

- Server components by default; add `"use client"` only at the interactive leaf.
  Do not pass component/function props (icons included) across the server→client
  boundary — keep the boundary at the component that owns them.
- Icons: `@remixicon/react` only.
- Reuse the vendored kit and brand utilities before writing new primitives.
- User-visible strings say **"skynet-a"** (or "Skynet"), never the template name.
- Do not remove the `@config '../tailwind.config.ts';` line from
  `app/globals.css` — it is what makes every AlignUI token resolve.
- `AGENTS.md` is hand-maintained; `agentRules: false` in `next.config.ts` stops
  Next from regenerating it.

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
