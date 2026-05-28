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
    // Tokyo Night blue, the product's Midnight accent.
    accent: "#7aa2f7",
    radius: "md",
    mode: "system",
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
