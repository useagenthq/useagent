import type { SandboxHandle } from "../sandboxes/provider";
import { acquireThreadSandbox } from "./thread-sandbox";
import { checkoutPullRequestResources, prepareRepos } from "./repo-prep";
import type { EngineRunContext } from "./types";
import { materializeRunInputs } from "../uploads/materialize";
import {
  composeSecretEnv,
  materializeSecretInjection,
  PROVIDER_SECRET_NAMES,
  recordSecretsInjected,
} from "../secrets/inject";
import { createSecretRedactor } from "../secrets/redact";

export interface SandboxTurnPreparationOptions<T> {
  readonly snapshot: string;
  readonly chip: string;
  readonly warmPool?: string;
  readonly labels?: Record<string, string>;
  readonly requiredLabels?: Record<string, string>;
  readonly timingPrefix: string;
  /** Providers that establish a lower-privilege runtime user must run after
   * repository/input materialization so ownership cannot race those writes. */
  readonly providerAfterResources?: boolean;
  readonly prepareProvider: (sandbox: SandboxHandle, workdir: string) => Promise<T>;
}

export interface PreparedSandboxTurn<T> {
  readonly sandbox: SandboxHandle;
  readonly workdir: string;
  readonly providerState: T;
  readonly redact: ReturnType<typeof createSecretRedactor>;
  close(): Promise<void>;
}

async function resolveWorkspaceRoot(sandbox: SandboxHandle): Promise<string> {
  const result = await sandbox.process.executeCommand(
    'mkdir -p "$HOME/work" && cd "$HOME/work" && pwd -P',
    undefined,
    undefined,
    10,
  );
  const workdir = result.result?.trim();
  if ((result.exitCode ?? 1) !== 0 || !workdir?.startsWith("/")) {
    throw new Error("Could not resolve the sandbox workspace");
  }
  return workdir;
}

/** Shared sandbox preparation for native resident harnesses. Provider setup is
 * the only variable step; repo, upload, secret, timing, and cleanup semantics
 * stay identical across adapters. */
export async function prepareSandboxTurn<T>(
  ctx: EngineRunContext,
  options: SandboxTurnPreparationOptions<T>,
): Promise<PreparedSandboxTurn<T>> {
  const secretInjection = await composeSecretEnv(ctx, { excludeNames: PROVIDER_SECRET_NAMES });
  const redact = createSecretRedactor(secretInjection.redactionValues);
  const endSandbox = ctx.timing?.begin(`${options.timingPrefix}.sandbox_acquire`);
  const lease = await acquireThreadSandbox(ctx, {
    snapshot: options.snapshot,
    chip: options.chip,
    warmPool: options.warmPool,
    labels: options.labels,
    requiredLabels: options.requiredLabels,
  });
  endSandbox?.();

  const endPrepare = ctx.timing?.begin(`${options.timingPrefix}.prepare`);
  try {
    const { sandbox } = lease;
    const stage = async <V>(name: string, operation: () => Promise<V>): Promise<V> => {
      const end = ctx.timing?.begin(`${options.timingPrefix}.prepare.${name}`);
      try {
        return await operation();
      } finally {
        end?.();
      }
    };
    const workdir = await stage("workspace_root", () => resolveWorkspaceRoot(sandbox));
    await stage("secrets", () =>
      materializeSecretInjection(
        (command) => sandbox.process.executeCommand(command, undefined, undefined, 30),
        secretInjection,
      ),
    );
    const prepareResources = () => Promise.all([
      stage("repos", async () => {
        await prepareRepos(sandbox, workdir, ctx);
        await checkoutPullRequestResources(
          sandbox,
          workdir,
          ctx.resolvedResources ?? [],
          ctx,
        );
      }),
      stage("inputs", () => materializeRunInputs(sandbox, ctx.inputFiles)),
    ]);
    let providerState: T;
    if (options.providerAfterResources) {
      await prepareResources();
      providerState = await stage("provider_bridge", () => options.prepareProvider(sandbox, workdir));
    } else {
      [providerState] = await Promise.all([
        stage("provider_bridge", () => options.prepareProvider(sandbox, workdir)),
        prepareResources(),
      ]);
    }
    await stage("secrets_marker", () => recordSecretsInjected(ctx, secretInjection));
    return {
      sandbox,
      workdir,
      providerState,
      redact,
      async close() {
        if (lease.releaseAfterRun) await sandbox.delete().catch(() => {});
      },
    };
  } catch (error) {
    if (lease.releaseAfterRun) await lease.sandbox.delete().catch(() => {});
    throw error;
  } finally {
    endPrepare?.();
  }
}
