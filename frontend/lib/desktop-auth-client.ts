import { electronProxyClient } from "@better-auth/electron/proxy";
import { createAuthClient } from "better-auth/client";
import { genericOAuthClient } from "better-auth/client/plugins";

export const desktopAuthClient = createAuthClient({
  plugins: [electronProxyClient({
    protocol: { scheme: "useagent" },
    callbackPath: "/auth/callback",
  }), genericOAuthClient()],
});
