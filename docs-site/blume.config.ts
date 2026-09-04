import { defineConfig } from "blume";

export default defineConfig({
  title: "UseAgent",
  description:
    "Run coding agents, manage their work, and keep the results in one workspace. Guides to UseAgent, its API, and self-hosting.",

  logo: {
    image: { light: "/useagent-mark.svg", alt: "UseAgent star-knot mark" },
    text: "UseAgent",
  },

  github: {
    owner: "useagenthq",
    repo: "useagent",
    branch: "main",
    dir: "docs-site",
  },

  content: {
    root: "docs",
  },

  theme: {
    accent: { light: "#245dc1", dark: "#8db8ff" },
    radius: "md",
    mode: "light",
    background: {
      light: "#ffffff",
      dark: "#101720",
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
