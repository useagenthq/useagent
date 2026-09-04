# useAgent docs

The product and developer documentation for useAgent. Built with
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
- `theme.css` sets readable article typography, light and dark colors, tables,
  and navigation styling. `components.ts` registers the Sidebar, Logo, and
  Breadcrumbs overrides in `components/`.
- `docs/` holds the content. Folders become sidebar groups; each group's
  `meta.ts` sets its title, icon, order, and page order.
- Navigation, search, breadcrumbs, and the on-page outline are inferred from the
  files. See the Blume docs bundled in `node_modules/blume/docs`.

Check content against the implementation, package scripts, and deployment files.
Keep source references on technical pages; do not treat older README claims as
proof of current behavior. Add new pages to their group's `meta.ts`.

Run `bun run doctor` and `bun run build` after changes. If a dev server is using
the generated `.blume/` directory, use `bun run build -- --isolated` to verify
in `.blume-verify/`. Inspect the rendered site in light and dark mode and at a
narrow width before shipping style changes.
