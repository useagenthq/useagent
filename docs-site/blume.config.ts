import { defineConfig } from "blume";

export default defineConfig({
  title: "UseAgent",
  description:
    "Run Codex, Claude Code, OpenCode, and Pi in isolated cloud computers, with durable threads, connected tools, and reviewable artifacts.",

  logo: {
    image: { light: "/useagent-mark.svg", alt: "UseAgent star-knot mark" },
    text: "UseAgent",
  },

  content: {
    root: "docs",
  },

  theme: {
    accent: "#3392ff",
    radius: "md",
    mode: "system",
    fonts: {
      display: "inter",
      body: "inter",
      mono: "jetbrains-mono",
    },
    background: {
      light: "#ffffff",
      dark: "#121212",
    },
  },

  navigation: {
    // This private Pro preview intentionally omits Blume's repository actions.
    // Pointing them at the public OSS repository would misrepresent the source
    // behind these pages.
    repo: false,
    sidebar: {
      display: "group",
    },
  },

  ai: {
    llmsTxt: true,
  },
});
