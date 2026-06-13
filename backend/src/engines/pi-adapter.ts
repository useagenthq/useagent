import type { EngineAdapter } from "./types";
import { composeTurnPrompt } from "./types";
import { providerGatewayWired } from "../provider-gateway/sandbox-config";
import { sessionCapabilities } from "./capabilities";
import { establishProviderSession, recordProviderSessionStarted } from "./provider-turn";
import { prepareSandboxTurn } from "./sandbox-turn-preparation";
import {
  runtimeRunSnapshot,
} from "./runtime-adapter";
import {
  RUNTIME_CUBE_WARM_POOL_NAME,
  RUNTIME_GENERATION,
  RUNTIME_GENERATION_LABEL,
} from "./runtime-environment";
import { piProviderDriver } from "./pi-provider-driver";
import { piBridgeManager } from "./pi-rpc-bridge";
import { preparePiRuntime, PI_BRIDGE_GENERATION } from "./pi-runtime-config";
import { createPiRpcFrameMapper } from "./pi-canonical";
import { runNativeBridgeTurn } from "./native-bridge-runtime";
import { buildExecutionCapabilitySnapshot } from "./execution-capabilities";

export const piAdapter: EngineAdapter = {
  id: "pi",
  async run(ctx) {
    if (!providerGatewayWired()) throw new Error("Pi requires a configured provider gateway");
    const startedAt = Date.now();
    await ctx.emit({ kind: "task", label: "Preparing Pi runtime and integrations…", chip: "pi" });
    const prepared = await prepareSandboxTurn(ctx, {
      snapshot: runtimeRunSnapshot(),
      chip: "pi",
      warmPool: RUNTIME_CUBE_WARM_POOL_NAME,
      labels: { [RUNTIME_GENERATION_LABEL]: RUNTIME_GENERATION },
      requiredLabels: { [RUNTIME_GENERATION_LABEL]: RUNTIME_GENERATION },
      timingPrefix: "pi",
      providerAfterResources: true,
      prepareProvider: (sandbox, workdir) => preparePiRuntime(sandbox, ctx, workdir),
    });
    try {
      // Preparation can outlive a client cancellation. Never create/resume a
      // native session or dispatch a provider request for an already-dead run.
      ctx.signal.throwIfAborted();
      const capabilities = sessionCapabilities("pi", {
        desktop: false,
        knowledgeTools: prepared.providerState.knowledgeTools,
      });
      const executionCapabilities = buildExecutionCapabilitySnapshot({
        runtime: "sandbox",
        workspaceRoot: prepared.workdir,
        gatewayAvailable: prepared.providerState.knowledgeTools,
        desktopAvailability: prepared.providerState.knowledgeTools ? "on_demand" : "unsupported",
      });
      const established = await establishProviderSession({
        driver: piProviderDriver,
        ctx,
        runtime: { kind: "sandbox", id: prepared.sandbox.id },
        capabilities,
        executionCapabilities,
        generation: PI_BRIDGE_GENERATION,
        startMetadata: { workdir: prepared.workdir, runtime: prepared.providerState },
        persistSession: async (nativeSessionId) => {
          if (!ctx.saveEngineSessionId) throw new Error("Session persistence is unavailable");
          await ctx.saveEngineSessionId(nativeSessionId);
        },
      });
      const bridge = piBridgeManager.get(established.session.nativeSessionId);
      if (!bridge) throw new Error("Pi RPC bridge session is unavailable");
      await recordProviderSessionStarted(ctx, established.session, {
        provider: "pi",
        source: "pi",
        resumed: established.resumed,
      });
      ctx.timing?.mark("dispatch");
      const summary = await runNativeBridgeTurn({
        ctx,
        driver: piProviderDriver,
        session: established.session,
        bridge,
        prompt: composeTurnPrompt(ctx, established.resumed, executionCapabilities),
        mapFrame: createPiRpcFrameMapper(`pi-message-${ctx.runId}`),
        redact: prepared.redact,
      });
      await ctx.emit({ kind: "done", label: "Done", chip: null });
      ctx.setSummary(summary.trim() || "Pi run completed", Date.now() - startedAt);
    } finally {
      await prepared.close();
    }
  },
};
