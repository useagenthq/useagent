import { defineComponents } from "blume";

export default defineComponents({
  layout: {
    // Full-trail breadcrumbs (Docs > Group > Page) instead of the single
    // eyebrow crumb.
    Breadcrumbs: "./components/Breadcrumbs.astro",
    // Quick Search pill above the nav tree; wraps the built-in tree.
    Sidebar: "./components/Sidebar.astro",
  },
});
