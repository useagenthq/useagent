# sidebar-kit: vendored sidebar primitives

Source: shadcn/ui, the Base UI flavored style, MIT. Fetched from the public
registry on 2026-09-05 through `shadcn add` and then edited in place; there is
no `components.json`, so the CLI does not manage these files. Sidebar patterns
follow the "Dashboard Inset" and "Double-Sided" sidebar blocks on blocks.so
(MIT). The primitives sit on `@base-ui/react`; there is no Radix here.

Files: `button`, `collapsible`, `input`, `separator`, `sheet`, `sidebar`,
`skeleton`, `tooltip`. Unused copied dialog and avatar wrappers were removed;
the account card uses the existing product Avatar.

## Token translation

The primitives read the shadcn color names. `app/globals.css` maps those names
onto this product's tokens at the end of the file (`--background`,
`--foreground`, `--sidebar*`, `--muted*`, `--accent*`, `--border`, `--ring`),
and an `@theme inline` block exposes them as utilities, so the sidebar follows
every theme without a palette of its own.

## Local changes

- `sidebar.tsx`: `useIsMobile` comes from `hooks/use-is-mobile` (the product's
  hook) instead of the registry's `use-mobile`; the inset wrapper keeps its side
  and bottom padding but no top padding, so the rail starts at the viewport
  edge.
- All icons come from `@remixicon/react`, aliased to the upstream names so the
  markup stays diffable against the registry.
- `cn` is this product's `cx` re-exported from `lib/utils`.

This is a bounded shell-layout exception: the shared frame, navigation rows and
mobile sheet use these coordinated primitives. Product buttons, chips, avatars
and dialogs continue to use `components/base`. Do not expand this folder into a
second general UI kit. Color aliases map to semantic tokens in every theme;
there are no dark-only color overrides.
