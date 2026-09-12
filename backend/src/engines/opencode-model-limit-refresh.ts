import { createHash } from "node:crypto";
import { markProviderGatewaySandboxCurrent } from "../provider-gateway/sandbox-config";
import { DEFAULT_OPENCODE_MODEL, openCodeRuntimeModelId } from "../runs/model-policy";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  prepareOpencodeSandboxConfig,
  readOpencodeSandboxConfig,
  writeOpencodeSandboxConfig,
} from "./opencode-server";
import { RUNTIME_ENVIRONMENT_HOME } from "./runtime-environment";
import type { EngineRunContext } from "./types";

const OPENCODE_MODEL_LIMIT_STATE_DIR = `${RUNTIME_ENVIRONMENT_HOME}/caches/opencode-model-limits`;

interface OpenCodeModelLimits {
  readonly context: number | null;
  readonly input: number | null;
  readonly output: number | null;
}

export interface OpenCodeModelLimitRefresh {
  readonly changed: boolean;
  readonly revision: string | null;
  readonly changedAt: string | null;
  readonly acknowledge: () => Promise<void>;
}

function openCodeModelLimitCatalog(
  config: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, OpenCodeModelLimits> {
  const catalog = new Map<string, OpenCodeModelLimits>();
  const providers = config.provider && typeof config.provider === "object"
    ? config.provider as Readonly<Record<string, unknown>>
    : null;
  for (const [providerId, providerValue] of Object.entries(providers ?? {})) {
    const provider = providerValue && typeof providerValue === "object"
      ? providerValue as Readonly<Record<string, unknown>>
      : null;
    const models = provider?.models && typeof provider.models === "object"
      ? provider.models as Readonly<Record<string, unknown>>
      : null;
    for (const [modelId, modelValue] of Object.entries(models ?? {})) {
      const model = modelValue && typeof modelValue === "object"
        ? modelValue as Readonly<Record<string, unknown>>
        : null;
      const limit = model?.limit && typeof model.limit === "object"
        ? model.limit as Readonly<Record<string, unknown>>
        : null;
      if (!limit) continue;
      const numericLimit = (key: "context" | "input" | "output"): number | null =>
        typeof limit[key] === "number" ? limit[key] : null;
      catalog.set(`${providerId}/${modelId}`, {
        context: numericLimit("context"),
        input: numericLimit("input"),
        output: numericLimit("output"),
      });
    }
  }
  return catalog;
}

function sameModelLimits(
  previous: OpenCodeModelLimits | undefined,
  next: OpenCodeModelLimits | undefined,
): boolean {
  return previous?.context === next?.context &&
    previous?.input === next?.input &&
    previous?.output === next?.output;
}

function openCodeModelLimits(
  config: Readonly<Record<string, unknown>>,
  requestedModel: string | undefined,
): OpenCodeModelLimits | null {
  const selected = openCodeRuntimeModelId(requestedModel?.trim() || DEFAULT_OPENCODE_MODEL);
  return openCodeModelLimitCatalog(config).get(selected) ?? null;
}

export function openCodeModelLimitsChanged(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  requestedModel?: string,
): boolean {
  const previous = openCodeModelLimits(before, requestedModel);
  const next = openCodeModelLimits(after, requestedModel);
  return !sameModelLimits(previous ?? undefined, next ?? undefined);
}

function modelLimitFingerprint(limits: OpenCodeModelLimits): string {
  return createHash("sha256").update(JSON.stringify(limits)).digest("hex");
}

interface OpenCodeModelLimitDesiredState {
  readonly fingerprint: string;
  readonly revision: string;
  readonly createdAt: string;
}

// The desired revision is model-wide because every retained T3 thread may own
// a resident OpenCode server. A per-thread acknowledgement prevents repeated
// stops while keeping a config-write crash recoverable on the next turn.
function modelLimitStatePaths(model: string, threadId: string): {
  readonly desired: string;
  readonly acknowledged: string;
} {
  const modelKey = createHash("sha256").update(model).digest("hex");
  const threadKey = createHash("sha256")
    .update(model)
    .update("\0")
    .update(threadId)
    .digest("hex");
  return {
    desired: `${OPENCODE_MODEL_LIMIT_STATE_DIR}/model-${modelKey}`,
    acknowledged: `${OPENCODE_MODEL_LIMIT_STATE_DIR}/thread-${threadKey}`,
  };
}

async function readModelLimitState(
  sandbox: SandboxHandle,
  paths: ReturnType<typeof modelLimitStatePaths>,
): Promise<{ readonly desired: OpenCodeModelLimitDesiredState | null; readonly acknowledged: string }> {
  const result = await sandbox.process.executeCommand(
    [
      "set -eu",
      `cat ${JSON.stringify(paths.desired)} 2>/dev/null || true`,
      "printf '\\n'",
      `cat ${JSON.stringify(paths.acknowledged)} 2>/dev/null || true`,
    ].join("\n"),
    undefined,
    undefined,
    10,
  );
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error("OpenCode model-limit refresh state read failed");
  }
  const [desiredRaw = "", acknowledged = ""] = (result.result ?? "").split("\n");
  let desired: OpenCodeModelLimitDesiredState | null = null;
  if (desiredRaw.trim()) {
    try {
      const parsed = JSON.parse(desiredRaw) as Partial<OpenCodeModelLimitDesiredState>;
      if (
        typeof parsed.fingerprint !== "string" ||
        typeof parsed.revision !== "string" ||
        typeof parsed.createdAt !== "string"
      ) {
        throw new Error("invalid state");
      }
      desired = parsed as OpenCodeModelLimitDesiredState;
    } catch {
      throw new Error("OpenCode model-limit refresh state is malformed");
    }
  }
  return { desired, acknowledged: acknowledged.trim() };
}

async function writeModelLimitState(
  sandbox: SandboxHandle,
  path: string,
  value: string,
): Promise<void> {
  const result = await sandbox.process.executeCommand(
    [
      "set -eu",
      `install -d -m 700 ${JSON.stringify(OPENCODE_MODEL_LIMIT_STATE_DIR)}`,
      "umask 077",
      `TMP=${JSON.stringify(`${path}.tmp.$$`)}`,
      'trap \'rm -f -- "$TMP"\' EXIT',
      `printf %s ${JSON.stringify(value)} > "$TMP"`,
      `mv -f -- "$TMP" ${JSON.stringify(path)}`,
      "trap - EXIT",
    ].join("\n"),
    undefined,
    undefined,
    10,
  );
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error("OpenCode model-limit refresh state write failed");
  }
}

export async function prepareOpenCodeGateway(
  sandbox: SandboxHandle,
  ctx: EngineRunContext,
): Promise<OpenCodeModelLimitRefresh> {
  const baseConfig = await readOpencodeSandboxConfig(sandbox);
  const previousCatalog = openCodeModelLimitCatalog(baseConfig);
  const prepared = await prepareOpencodeSandboxConfig(sandbox, ctx, baseConfig);
  if (!prepared?.state.provider) {
    throw new Error("the provider runtime OpenCode provider gateway configuration failed");
  }
  const nextCatalog = openCodeModelLimitCatalog(prepared.config);
  const selectedModel = openCodeRuntimeModelId(ctx.model?.trim() || DEFAULT_OPENCODE_MODEL);
  const threadId = ctx.threadId ?? ctx.runId;
  const states = new Map<string, {
    readonly paths: ReturnType<typeof modelLimitStatePaths>;
    readonly state: Awaited<ReturnType<typeof readModelLimitState>>;
    readonly desired: OpenCodeModelLimitDesiredState | null;
  }>();
  const ensureDesired = async (
    model: string,
    limits: OpenCodeModelLimits,
    configChanged: boolean,
  ) => {
    const paths = modelLimitStatePaths(model, threadId);
    const state = await readModelLimitState(sandbox, paths);
    const fingerprint = modelLimitFingerprint(limits);
    let desired = state.desired;
    const completedPriorRevision = configChanged &&
      desired !== null &&
      state.acknowledged === desired.revision;
    // Preserve the revision when retrying an unacknowledged write, but mint a
    // new one when a completed B -> C -> B cycle returns to the same limits.
    const needsNewRevision = desired === null
      ? configChanged
      : desired.fingerprint !== fingerprint || completedPriorRevision;
    if (needsNewRevision) {
      desired = {
        fingerprint,
        revision: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
      await writeModelLimitState(sandbox, paths.desired, JSON.stringify(desired));
    }
    const result = { paths, state, desired };
    states.set(model, result);
    return result;
  };

  // Config generation mutates every managed model definition. Persist every
  // changed tuple before the global write, even when this turn selected a
  // different model, so a later retained thread cannot miss the revision.
  for (const [model, limits] of nextCatalog) {
    if (!sameModelLimits(previousCatalog.get(model), limits)) {
      await ensureDesired(model, limits, true);
    }
  }

  const selectedLimits = nextCatalog.get(selectedModel);
  const selected = selectedLimits
    ? states.get(selectedModel) ?? await ensureDesired(selectedModel, selectedLimits, false)
    : null;
  let refresh: OpenCodeModelLimitRefresh = {
    changed: false,
    revision: null,
    changedAt: null,
    async acknowledge() {},
  };
  if (selected) {
    const { paths, state, desired } = selected;
    refresh = {
      changed: desired !== null && state.acknowledged !== desired.revision,
      revision: desired?.revision ?? null,
      changedAt: desired?.createdAt ?? null,
      acknowledge: async () => {
        if (desired && state.acknowledged !== desired.revision) {
          await writeModelLimitState(sandbox, paths.acknowledged, desired.revision);
        }
      },
    };
  }
  await writeOpencodeSandboxConfig(sandbox, prepared.config);
  await markProviderGatewaySandboxCurrent(sandbox);
  return refresh;
}
