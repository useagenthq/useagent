import { defineComponents } from "blume";
import Breadcrumbs from "./components/Breadcrumbs.astro";
import Logo from "./components/Logo.astro";
import Sidebar from "./components/Sidebar.astro";

export default defineComponents({
  layout: {
    // Full-trail breadcrumbs (Docs > Group > Page) instead of the single
    // eyebrow crumb.
    Breadcrumbs,
    // Brand mark as a real <img src="/useagent-mark.svg"> (the built-in inlines
    // local SVGs into a <span> instead).
    Logo,
    // Quick Search pill above the nav tree; wraps the built-in tree.
    Sidebar,
  },
});
