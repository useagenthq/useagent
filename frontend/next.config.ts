import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

// Turbopack infers the project root as `frontend/`, but our shared libraries are
// file:-linked from `../packages` (OUTSIDE that inferred root), so Turbopack rejected the
// linked package.json as an out-of-root "Invalid symlink". Point the root at the
// repository root (the common parent of frontend/ and packages/) so the linked package
// sources resolve; transpilePackages has Turbopack transpile their raw TypeScript.
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const nextConfig: NextConfig = {
  turbopack: {
    root: repositoryRoot,
    // root fixes symlink-following into ../packages, but shifts the node_modules base
    // off frontend/; map the bare specifiers straight to the linked package sources.
    // resolveAlias paths are relative to the PROJECT dir (frontend/), not the root.
    resolveAlias: {
      "@skynet/agent-client": "../packages/agent-client/src/index.ts",
      "@skynet/agent-harness": "../packages/agent-harness/src/index.ts",
      "@skynet/agent-harness/canonical": "../packages/agent-harness/src/canonical.ts",
    },
  },
  transpilePackages: ["@skynet/agent-client", "@skynet/agent-harness"],
  // Env-gated dist dir so an isolated verification build never clobbers a running dev
  // server's `.next`. Defaults to the normal `.next` when unset.
  distDir: process.env.SKYNET_BUILD_DIST || ".next",
  // We maintain AGENTS.md by hand — stop Next 16 from regenerating it.
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1"],
  async rewrites() {
    // Same override lib/backend-fetch.ts honors, so one env var retargets both
    // the server-side fetches and this client-side rewrite (e.g. :3501 locally).
    const origin = process.env.SKYNET_API_ORIGIN ?? "http://localhost:3201";
    return [
      {
        source: "/api/:path*",
        destination: `${origin}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
