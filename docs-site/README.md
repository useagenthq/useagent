# Skynet docs

The product documentation site for Skynet, the Loop agent platform. Built with
[Blume](https://github.com/haydenbleasel/blume), a markdown-first docs framework
on Astro and Vite.

## Develop

```bash
bun install
bun dev      # http://localhost:4321 with hot reload
```

## Build

```bash
bun run build    # static site to dist/, with a local search index
bun run doctor   # diagnose configuration and content problems
```

## Structure

- `blume.config.ts` sets the title, theme, GitHub links, and navigation.
- `docs/` holds the content. Folders become sidebar groups; each group's
  `meta.ts` sets its title, icon, order, and page order.
- Navigation, search, breadcrumbs, and the on-page outline are inferred from the
  files. See the Blume docs bundled in `node_modules/blume/docs`.

Content is authored from the repository's root `README.md`, which remains the
source of truth for the product.
