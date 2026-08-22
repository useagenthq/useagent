import { defineComponents } from "blume";
import Breadcrumbs from "./components/Breadcrumbs.astro";
import Sidebar from "./components/Sidebar.astro";

export default defineComponents({
  layout: {
    // Full-trail breadcrumbs (Docs > Group > Page) instead of the single
    // eyebrow crumb.
    Breadcrumbs,
    // Quick Search pill above the nav tree; wraps the built-in tree.
    Sidebar,
  },
});
