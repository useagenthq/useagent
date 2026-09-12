import { defineComponents } from "blume";
import Breadcrumbs from "./components/Breadcrumbs.astro";
import Logo from "./components/Logo.astro";
import Sidebar from "./components/Sidebar.astro";

export default defineComponents({
  layout: {
    Breadcrumbs,
    Logo,
    Sidebar,
  },
});
