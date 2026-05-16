# Design ramp — skynet-a

The single reference for **type**, **radius**, and **borders**. Read before adding any
heading, card, row, or chrome. The house style is focused + soft (Vite+/reference-composer
playbook): one compact display face against a neutral UI, generously rounded surfaces, and
borders that are barely-there hairlines.

---

## 1. Type

### The pairing

| Role        | Face                     | Wiring                                  | Why |
| ----------- | ------------------------ | --------------------------------------- | --- |
| **Display** | **Inter Tight**          | `--font-display`, `next/font/google`    | A compact, expressive companion to Inter for Vite+-style product heroes without a proprietary font dependency. |
| **UI / body** | **Inter**              | `--font-sans`, applied to `<html>`      | Neutral and highly readable at chat, navigation, form, table, and tool-output sizes. Tuned with `font-feature-settings: 'cv11','ss01','liga','calt'` + `text-rendering: optimizeLegibility` (set once on `<html>` in globals.css). |
| **Mono**    | **JetBrains Mono**       | `--font-mono`                           | Code, IDs, technical labels, `.text-mono-label` overlines. |

APK Protocol is the preferred licensed display face. Inter Tight is the current
open-source substitute until licensed APK Protocol webfont files are available.

### When to use display vs sans

**The display face is a scalpel, not a paintbrush.** Use it for the top-level page
hero only. Everything else (section headings, card titles, nav, body, captions)
stays in the Inter scale. That contrast is the whole effect.

- ✅ Page hero `<h1>` → display ramp
- ❌ Section `<h2>`, card titles, sidebar labels → keep sans (`text-title-*`, `text-label-*`)

### The display ramp (globals.css `@utility`)

Each class sets Inter Tight + size + tuned tracking.

| Class             | Size  | Line / tracking     | Use for |
| ----------------- | ----- | ------------------- | ------- |
| `text-display-lg` | 40px  | 1.05 / -0.035em     | Dedicated onboarding / welcome heroes |
| `text-display-md` | 32px  | 1.10 / -0.03em      | Primary page heroes (dashboard, agent/new) |
| `text-display-sm` | 24px  | 1.15 / -0.025em     | In-header page titles (runs, settings, knowledge) |
| `font-display`    | any   | —                   | Display family at a custom size |

Sweep migration: `text-title-h4` hero → `text-display-md`/`lg`; `text-title-h5` hero → `text-display-sm`.

### Sans hierarchy (unchanged AlignUI scale)

- **Headings / emphasis:** `text-title-h4…h6`, `text-label-lg…sm` + `text-text-strong-950`
- **Body / secondary:** `text-paragraph-md…sm` + `text-text-sub-600`
- **Captions / tertiary:** `text-paragraph-xs`, `text-label-xs` + `text-text-soft-400`
- **Overlines:** `text-mono-label` + `text-text-soft-400`

Large title tokens (`title-h1…h4`) were tightened (~-0.02em) in `tailwind.config.ts`.

### UI-type refinement — @_heyrico "clean UI" blueprint (applied with Inter)

The blueprint calls for **SF Pro or closest**; Inter is already the app font, so the
refinement lands as three token-level rules:

- **Weights:** Inter **regular (400)** + **medium (500)** only — already the AlignUI split
  (`paragraph-*` = 400, `label-*` = 500). No other weights for UI text.
- **Tracking = -0.15px** on all UI text (the SF-Pro-adjacent optical signature). Set as the
  global base on `<html>` (`letter-spacing: -0.15px`, catches all raw text) **and** baked into
  the core UI-text tokens `label-md/sm/xs` + `paragraph-md/sm/xs` in `tailwind.config.ts` so
  tokenized and raw text agree. The serif display ramp and `text-mono-label` set their own
  tracking and override this (correct — they are not UI text).
- **UI size scale = 12 / 13 / 14 / 24px.** 12–13px → captions + labels (`label-xs`
  `paragraph-xs` = 12px), 14px → body/default (`label-sm` `paragraph-sm` = 14px), 24px → the
  page display size (the `text-display-sm` hero). Keep UI text inside this range — don't
  reach for the large sans `title-*` tokens for chrome; the display face owns the display slot.

### Text hierarchy — three grays on the semantic ladder

The blueprint's light-mode ink ladder (#292929 strong / #5D5D5D mid / #9E9E9E muted) is a
**relationship**, not a set of hexes to paste into a dark theme. That relationship already
lives in the AlignUI semantic text tokens — map onto them, never hard-code the hexes:

| Blueprint role        | Token                   | Light ≈ ratio       | Dark (inverted)      |
| --------------------- | ----------------------- | ------------------- | -------------------- |
| **Strong** (#292929)  | `text-text-strong-950`  | near-black ~13–16:1 | white                |
| **Mid** (#5D5D5D)     | `text-text-sub-600`     | ~6.5:1              | warm mid-gray (58%L) |
| **Muted** (#9E9E9E)   | `text-text-soft-400`    | ~3:1                | dim gray (44%L)      |

The light-mode neutrals already sit almost exactly on the blueprint ratios, and `.dark`
re-anchors them so the same three-step ladder reads on the dark canvas — so **no color token
changed**. Rule: strong → sub → soft for primary → secondary → tertiary. Don't flatten two
tiers into one; don't invent a fourth gray.

---

## 2. Radius (blueprint: one card radius, 8px nav, pill CTAs)

Match `components/chat` — do not diverge.

| Surface                                            | Radius          | Tailwind class   |
| -------------------------------------------------- | --------------- | ---------------- |
| Cards, list rows, panels, composer, heroes         | **16px**        | `rounded-2xl`    |
| Navigation elements (sidebar rows, tab pills, icon-chrome) | **8px** | `rounded-lg`     |
| CTAs / buttons                                     | **pill** (full) | `rounded-full`   |
| Inner inputs / small chrome                        | 12px            | `rounded-xl`     |
| Chips / avatars / status dots                      | full            | `rounded-full`   |

Notes:
- **One card radius: `rounded-2xl` (16px)** for every page-level card, list row, panel, AND the
  large composer/hero surfaces. The old 24px (`rounded-3xl`) and 28px (`rounded-[28px]`) tiers
  are retired — the blueprint flattens them to a single 16px so surfaces read uniform.
- Floating menus/popovers also stay `rounded-2xl` (16px) — same as cards now.
- **Nav elements are `rounded-lg` (8px)** — sidebar rows, top-nav tab pills, header icon
  buttons. Already the shell default; keep it there.
- **CTAs/buttons are pill.** The vendored `components/ui/button` defaults to `rounded-10`; do
  NOT fork it — pass `className="rounded-full"` on the `Button.Root`/`FancyButton.Root` call
  site (tailwind-merge lets it win). Every product CTA carries it.
- Don't reach below `rounded-lg` for interactive controls; `rounded-md` is for tiny inline
  chrome (progress bars, code chips) only.

---

## 3. Borders (barely-there hairlines)

Elevation comes from **background step + shadow**, not from stroke weight.

- Static chrome uses a **single hairline**: `border border-stroke-soft-200` (or `ring-1 ring-inset ring-stroke-soft-200`).
- **Never** `border-2` / `ring-2` for static chrome. (`focus-visible:ring-2` for keyboard focus is fine — it's not static.)
- Do **not** re-brighten the dark border tokens. The global dark ramp already dims them
  (`--neutral-700` ≈ 13% L, `--neutral-600` ≈ 19% L) so borders read as faint hairlines on
  the #17181a canvas. Lean on `bg-*` elevation + `shadow-regular-*` for separation instead.

---

## Rhythm

- Muted secondary text = `text-text-sub-600`; tertiary = `text-text-soft-400`. Don't flatten.
- **Icon sizes (blueprint):** navigation-row icons at **14px** (`size-3.5`); card leading icons
  at **20px** (`size-5`). Header/toolbar icon-buttons stay 20px (`size-5`).
- Verify every surface on both the dark #17181a canvas AND light mode.
</content>
