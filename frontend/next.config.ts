import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/constants";
import { fileURLToPath } from "node:url";

// Turbopack infers the project root as `frontend/`, but our shared libraries are
// file:-linked from `../packages` (OUTSIDE that inferred root), so Turbopack rejected the
// linked package.json as an out-of-root "Invalid symlink". Point the root at the
// repository root (the common parent of frontend/ and packages/) so the linked package
// sources resolve; transpilePackages has Turbopack transpile their raw TypeScript.
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * distDir isolation is MECHANICAL, not a convention. A `next build` / `next start`
 * ALWAYS writes to a SEPARATE `.next-build` dir from the dev server's `.next`, so a
 * production build can never poison (or be poisoned by) a running dev server's Turbopack
 * cache - which is exactly what corrupted the compiled CSS and 500'd the dev server. The
 * dev server keeps the conventional `.next`. `SKYNET_BUILD_DIST` still overrides for a
 * caller that wants an explicitly-named isolated dir (e.g. a parallel E2E stack).
 */
function resolveDistDir(phase: string): string {
  if (process.env.SKYNET_BUILD_DIST) return process.env.SKYNET_BUILD_DIST;
  if (phase === PHASE_PRODUCTION_BUILD || phase === PHASE_PRODUCTION_SERVER) return ".next-build";
  return ".next";
}

export default function nextConfig(phase: string): NextConfig {
  return {
    turbopack: {
      root: repositoryRoot,
      // root fixes symlink-following into ../packages, but shifts the node_modules base
      // off frontend/; map the bare specifiers straight to the linked package sources.
      // resolveAlias paths are relative to the PROJECT dir (frontend/), not the root.
      resolveAlias: {
        "@skynet/agent-client": "../packages/agent-client/src/index.ts",
        "@skynet/agent-client/org-changes": "../packages/agent-client/src/org-changes.ts",
        "@skynet/agent-client/provider-connections":
          "../packages/agent-client/src/provider-connections.ts",
        "@skynet/agent-harness": "../packages/agent-harness/src/index.ts",
        "@skynet/agent-harness/canonical": "../packages/agent-harness/src/canonical.ts",
        "@skynet/agent-harness/opencode": "../packages/agent-harness/src/opencode-canonical.ts",
        "@skynet/artifact-workspace": "../packages/artifact-workspace/src/index.ts",
      },
    },
    distDir: resolveDistDir(phase),
    generateBuildId: async () => process.env.NEXT_PUBLIC_SKYNET_RELEASE_COMMIT || null,
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
}
