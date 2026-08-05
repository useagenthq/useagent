# prompt-kit (vendored)

Chat primitives vendored from **prompt-kit** (https://www.prompt-kit.com) — the
per-component registry JSONs (`prompt-kit.com/c/<name>.json`). Kept as a
top-level library dir (chartden convention: one kebab-case file per component)
so app compositions in `components/chat/**` import from `@/components/prompt-kit/*`
rather than reaching into a feature folder.

**Do not scatter forks.** Compose these; if a component needs app-specific
behavior, wrap it in `components/chat/**`.

## Components

| File | Export(s) | Status |
|------|-----------|--------|
| `markdown.tsx` | `Markdown` | Adapted — block-split + memoized; code fences render through `@/components/ai/code-block` (beautiful-ui chrome), inline code → AlignUI `bg-bg-weak-50`. |
| `message.tsx` | `Message`, `MessageAvatar`, `MessageContent`, `MessageActions`, `MessageAction` | Verbatim (tokens remapped). |
| `response-stream.tsx` | `ResponseStream` | Verbatim — typewriter/fade streaming engine. |
| `prompt-input.tsx` | `PromptInput`, `PromptInputTextarea`, … | Verbatim (tokens remapped). |
| `prompt-suggestion.tsx` | `PromptSuggestion` | Verbatim (tokens remapped). |
| `button.tsx` | `Button`, `buttonVariants` | Verbatim — prompt-kit's internal button used by `prompt-suggestion`. |
| `loader.tsx` + `loader.css` | `Loader` | Verbatim. |
| `code-block.tsx` | `CodeBlock`, `CodeBlockCode`, `CodeBlockGroup` | Superseded for app use by `@/components/ai/code-block` (beautiful-ui port). Kept for kit completeness. |

## shadcn → AlignUI token map

The upstream components use shadcn CSS-vars; remapped to AlignUI semantic tokens
(theme-flipping via the `.dark` class — never `dark:` prefixes):

| shadcn | AlignUI |
|--------|---------|
| `bg-background` / `bg-card` | `bg-bg-white-0` |
| `bg-muted` / `bg-primary-foreground` | `bg-bg-weak-50` |
| `bg-accent` / hover | `bg-bg-soft-200` |
| `text-foreground` | `text-text-strong-950` |
| `text-muted-foreground` | `text-text-sub-600` / `-soft-400` |
| `border` / `border-input` | `border-stroke-soft-200` |
| `text-primary` / links | `text-blue-500` |
| `rounded-lg` / `rounded-md` | `rounded-2xl` (cards, 16px) / `rounded-full` (chips, pill CTAs) per the app radius standard |

Highlighting is shiki dual-theme (`github-light` / `github-dark-default`);
the `.dark .shiki` swap in `app/globals.css` keeps tokens legible on the warm
`#20201f` dark ladder.
