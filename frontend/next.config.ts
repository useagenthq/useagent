import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
