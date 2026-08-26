# ThinkingOrb

A dotted "thought-orb" loading indicator: an honestly-3D field of depth-shaded
dots rendered on a `<canvas>`. Ships six states — `working`, `searching`,
`solving`, `listening`, `composing`, `shaping` — at two tuned sizes (`64` and
`20` CSS px). Auto light/dark, reduced-motion aware, and self-pausing while
offscreen or on hidden tabs.

## Usage

```tsx
import { ThinkingOrb } from "@/components/base/thinking-orb";

<ThinkingOrb state="searching" size={64} />;   // theme="auto" by default
<ThinkingOrb state="working" size={20} theme="dark" />;
```

`state`, `size`, `theme` (`auto | dark | light`), `speed`, and `paused` are the
props; any other `<canvas>` attribute (e.g. `className`, `aria-label`) passes
through.

## Theming

The canvas draws matte grayscale ink — dark ink on light substrates, mirrored to
light ink on dark ones. With `theme="auto"` (default) the substrate is resolved
from the nearest ancestor carrying a `.dark` / `.light` class or
`data-theme="dark|light"` attribute, falling back to
`prefers-color-scheme`. In useAgent that ancestor-`.dark` convention is exactly
what `next-themes` writes (`attribute="class"`, `defaultTheme="dark"` on
`<html>`; see `app/providers.tsx`), so the orb tracks the app theme with no extra
wiring. Because the art is grayscale-by-depth rather than brand-colored, there
are no color tokens to map — the orb needs no AlignUI token adaptation and the
only theming surface is this light/dark substrate.

## Source & license

- Vendored into useAgent from **chartden** (`frontend/components/base/thinking-orb/`),
  which itself ports the upstream indicator below.
- Upstream: [`Jakubantalik/thinking-orbs`](https://github.com/Jakubantalik/thinking-orbs)
- License: MIT © 2026 Jakub Antalik

## Adaptation notes

Vendored faithfully from chartden's port (which was ported faithfully from
upstream `src/`). Changes carried over from that port:

- `ThinkingOrb.tsx` → `thinking-orb.tsx`, prefixed with `"use client"` (the rAF
  paint loop, `IntersectionObserver`, and `matchMedia`/`MutationObserver` theme
  watchers are all client-only). Logic is otherwise unchanged.
- `index.ts` barrel updated to import from `./thinking-orb`.
- Quotes normalized to double-quote style; no behavioral edits.
- `engine/`, `presets.ts`, `theme.ts`, `types.ts` are copied verbatim — pure
  TypeScript with no external dependencies and no hardcoded brand colors.

useAgent adaptations (this port):

- Comment references to BoardUI's dark-mode convention retargeted to useAgent's
  `next-themes` `.dark`-class setup — no code change (the resolver already keys
  off an ancestor `.dark` class / `data-theme`).
- No import rewrites were needed: the component and engine reference no design-
  system helpers (`cn`/`cnExt`) or tokens, so the canvas/gradient rendering is
  kept verbatim.
- Integrated in `components/chat/orb-boot-indicator.tsx` (session queued/boot
  phase) and demoed in `/lab`.
