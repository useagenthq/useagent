import { defineConfig } from "blume";

export default defineConfig({
  title: "useAgent",
  description:
    "A multi-harness agent platform. An event-sourced control plane drives replaceable coding engines in isolated sandboxes and renders every run from one canonical event log.",

  logo: {
    text: "useAgent",
  },

  github: {
    owner: "useagenthq",
    repo: "skynet",
    branch: "main",
    dir: "docs-site",
  },

  content: {
    root: "docs",
  },

  theme: {
    // BoardUI-style palette: blue-500 accent on clean, light-first neutrals.
    // The rest of the look (surfaces, shadows, sidebar, rails) lives in theme.css.
    accent: "#3392ff",
    radius: "md",
    mode: "light",
    background: {
      light: "#ffffff",
      dark: "#121212",
    },
  },

  navigation: {
    sidebar: {
      // Collapsible sections keep the deeper concept pages tidy.
      display: "group",
    },
  },

  ai: {
    llmsTxt: true,
  },
});
