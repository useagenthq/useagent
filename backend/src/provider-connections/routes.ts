import { Hono, type Context } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import {
  cancelManagedCodexChatGptLogin,
  readManagedCodexChatGptStatus,
  revokeManagedCodexChatGptLogin,
  startManagedCodexChatGptLogin,
  type CodexAppServerLoginStartResult,
  type CodexChatGptStatus,
} from "./codex-app-server";
import {
  getCurrentUserProviderConnection,
  listCurrentUserProviderConnections,
  revokeCurrentUserProviderConnection,
  upsertApiKeyProviderConnection,
  type ProviderConnectionMeta,
} from "./service";
import {
  DaytonaConnectionValidationError,
  daytonaValidationHttpStatus,
  validateDaytonaConnection,
} from "./daytona";
import {
  isProviderConnectionAuthMethod,
  isProviderConnectionProvider,
  readDaytonaConnectionMetadata,
  readModelProviderMetadata,
  type ProviderConnectionAuthMethod,
} from "./types";

export interface CodexChatGptOAuthLifecycle {
  start(input: {
    scope: { orgId: string; userId: string };
    loginMethod?: "chatgpt" | "device_code";
  }): Promise<CodexAppServerLoginStartResult>;
  status(input: {
    scope: { orgId: string; userId: string };
  }): Promise<CodexChatGptStatus>;
  cancel(input: {
    scope: { orgId: string; userId: string };
    loginId: string;
  }): Promise<{ status: string }>;
  revoke(input: {
    scope: { orgId: string; userId: string };
  }): Promise<ProviderConnectionMeta | null>;
}

const defaultCodexChatGptOAuthLifecycle: CodexChatGptOAuthLifecycle = {
  start: startManagedCodexChatGptLogin,
  status: readManagedCodexChatGptStatus,
  cancel: cancelManagedCodexChatGptLogin,
  revoke: revokeManagedCodexChatGptLogin,
};

export function createProviderConnectionsRoutes(input: {
  codexChatGptOAuth?: CodexChatGptOAuthLifecycle;
  validateDaytona?: typeof validateDaytonaConnection;
} = {}): Hono<AppEnv> {
  const providerConnectionsRoutes = new Hono<AppEnv>();
  const codexChatGptOAuth = input.codexChatGptOAuth ?? defaultCodexChatGptOAuthLifecycle;
  const validateDaytona = input.validateDaytona ?? validateDaytonaConnection;

  providerConnectionsRoutes.use("*", orgScope);

  function requireUserScope(c: Context<AppEnv>) {
    const userId = c.get("userId");
    if (!userId) return null;
    return { orgId: c.get("orgId"), userId };
  }

  providerConnectionsRoutes.get("/", async (c) => {
    const scope = requireUserScope(c);
    if (!scope) return c.json({ error: "user_required" }, 403);
    const connections = await listCurrentUserProviderConnections(scope);
    return c.json({ connections });
  });

  providerConnectionsRoutes.post("/openai/chatgpt-oauth/start", async (c) => {
    const scope = requireUserScope(c);
    if (!scope) return c.json({ error: "user_required" }, 403);
    // Hosted connections cannot receive Codex's loopback browser callback. Keep
    // this server-side invariant so stale clients cannot restart that flow.
    const login = await codexChatGptOAuth.start({ scope, loginMethod: "device_code" });
    return c.json({ login });
  });

  providerConnectionsRoutes.get("/openai/chatgpt-oauth/status", async (c) => {
    const scope = requireUserScope(c);
    if (!scope) return c.json({ error: "user_required" }, 403);
    const status = await codexChatGptOAuth.status({ scope });
    return c.json({ status });
  });

  providerConnectionsRoutes.post("/openai/chatgpt-oauth/cancel", async (c) => {
    const scope = requireUserScope(c);
    if (!scope) return c.json({ error: "user_required" }, 403);
    let body: Record<string, unknown>;
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const loginId = typeof body.loginId === "string" ? body.loginId : "";
    if (!loginId) return c.json({ error: "loginId is required" }, 400);
    const result = await codexChatGptOAuth.cancel({ scope, loginId });
    return c.json(result);
  });

  providerConnectionsRoutes.post("/openai/chatgpt-oauth/revoke", async (c) => {
    const scope = requireUserScope(c);
    if (!scope) return c.json({ error: "user_required" }, 403);
    const connection = await codexChatGptOAuth.revoke({ scope });
    if (!connection) return c.json({ error: "provider connection not found" }, 404);
    return c.json({ connection });
  });

  providerConnectionsRoutes.get("/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!isProviderConnectionProvider(provider)) {
      return c.json({ error: "unknown provider" }, 400);
    }
    const authMethod = c.req.query("authMethod");
    let parsedAuthMethod: ProviderConnectionAuthMethod | undefined;
    if (authMethod !== undefined) {
      if (!isProviderConnectionAuthMethod(authMethod)) {
        return c.json({ error: "unknown auth method" }, 400);
      }
      parsedAuthMethod = authMethod;
    }
    const scope = requireUserScope(c);
    if (!scope) return c.json({ error: "user_required" }, 403);
    const connection = await getCurrentUserProviderConnection({
      ...scope,
      provider,
      authMethod: parsedAuthMethod,
    });
    if (!connection) return c.json({ error: "provider connection not found" }, 404);
    return c.json({ connection });
  });

  providerConnectionsRoutes.put("/:provider/api-key", async (c) => {
    const provider = c.req.param("provider");
    if (!isProviderConnectionProvider(provider)) {
      return c.json({ error: "unknown provider" }, 400);
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) return c.json({ error: "apiKey is required" }, 400);
    if (apiKey.length > 8_192) return c.json({ error: "apiKey is too long" }, 400);

    const scope = requireUserScope(c);
    if (!scope) return c.json({ error: "user_required" }, 403);

    const daytonaMetadata = provider === "daytona"
      ? readDaytonaConnectionMetadata(body.metadata)
      : null;
    if (provider === "daytona" && !daytonaMetadata) {
      return c.json({ error: "valid Daytona snapshotName is required" }, 400);
    }
    const metadata = daytonaMetadata ?? readModelProviderMetadata(body.metadata);
    if (provider === "daytona") {
      try {
        await validateDaytona({ apiKey, snapshotName: daytonaMetadata!.snapshotName });
      } catch (error) {
        if (error instanceof DaytonaConnectionValidationError) {
          return c.json({ error: error.code }, daytonaValidationHttpStatus(error.code));
        }
        throw error;
      }
    }

    const connection = await upsertApiKeyProviderConnection({
      ...scope,
      provider,
      apiKey,
      metadata,
    });
    return c.json({ connection });
  });

  providerConnectionsRoutes.post("/:provider/revoke", async (c) => {
    const provider = c.req.param("provider");
    if (!isProviderConnectionProvider(provider)) {
      return c.json({ error: "unknown provider" }, 400);
    }
    const authMethod = c.req.query("authMethod");
    let parsedAuthMethod: ProviderConnectionAuthMethod | undefined;
    if (authMethod !== undefined) {
      if (!isProviderConnectionAuthMethod(authMethod)) {
        return c.json({ error: "unknown auth method" }, 400);
      }
      parsedAuthMethod = authMethod;
    }
    if (provider === "openai" && parsedAuthMethod === undefined) {
      return c.json({ error: "authMethod is required for openai revoke" }, 400);
    }
    const scope = requireUserScope(c);
    if (!scope) return c.json({ error: "user_required" }, 403);
    const connection = provider === "openai" && parsedAuthMethod === "chatgpt_oauth"
      ? await codexChatGptOAuth.revoke({ scope })
      : await revokeCurrentUserProviderConnection({
          ...scope,
          provider,
          authMethod: parsedAuthMethod,
        });
    if (!connection) return c.json({ error: "provider connection not found" }, 404);
    return c.json({ connection });
  });

  return providerConnectionsRoutes;
}

export const providerConnectionsRoutes = createProviderConnectionsRoutes();
