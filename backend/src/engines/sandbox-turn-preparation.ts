import { sandboxRuntimeLayout, type SandboxHandle } from "../sandboxes/provider";
import type { SandboxBinding } from "../sandboxes/binding";
import { acquireThreadSandbox } from "./thread-sandbox";
import {
  checkoutPullRequestResources,
  prepareRepos,
  runtimeUserOwnershipMarker,
  shq,
} from "./repo-prep";
import type { EngineRunContext } from "./types";
import { materializeRunInputs } from "../uploads/materialize";
import {
  composeSecretEnv,
  materializeSecretInjection,
  PROVIDER_SECRET_NAMES,
  recordSecretsInjected,
} from "../secrets/inject";
import { createSecretRedactor } from "../secrets/redact";
import { resolveRuntimeWorkspaceRoot } from "./runtime-environment";

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
  /** Provider-specific retained-sandbox fencing that must complete before any
   * repository or input mutation begins. */
  readonly prepareSandbox?: (
    sandbox: SandboxHandle,
    binding: SandboxBinding,
  ) => Promise<void>;
  /** One-time provider installation for a fresh sandbox. This phase may write
   * stable runtime settings, but must not mint a run-bound capability or lease. */
  readonly prepareStableProvider?: (
    sandbox: SandboxHandle,
    workdir: string,
    binding: SandboxBinding,
  ) => Promise<void>;
  readonly resourceUser?: {
    readonly uid: number;
    readonly gid: number;
    readonly home: string;
  } | ((binding: SandboxBinding) => {
    readonly uid: number;
    readonly gid: number;
    readonly home: string;
  } | undefined);
  readonly prepareProvider: (
    sandbox: SandboxHandle,
    workdir: string,
    binding: SandboxBinding,
  ) => Promise<T>;
  readonly closeProvider?: (state: T) => Promise<void>;
}

export interface PreparedSandboxTurn<T> {
  readonly sandbox: SandboxHandle;
  readonly workdir: string;
  readonly providerState: T;
  readonly redact: ReturnType<typeof createSecretRedactor>;
  close(): Promise<void>;
}

/** Shared sandbox preparation for native resident harnesses. Provider setup is
 * the only variable step; repo, upload, secret, timing, and cleanup semantics
 * stay identical across adapters. */
export async function prepareSandboxTurn<T>(
  ctx: EngineRunContext,
  options: SandboxTurnPreparationOptions<T>,
  dependencies: {
    readonly acquireThreadSandbox: typeof acquireThreadSandbox;
  } = { acquireThreadSandbox },
): Promise<PreparedSandboxTurn<T>> {
  const secretInjection = await composeSecretEnv(ctx, { excludeNames: PROVIDER_SECRET_NAMES });
  const redact = createSecretRedactor(secretInjection.redactionValues);
  const endSandbox = ctx.timing?.begin(`${options.timingPrefix}.sandbox_acquire`);
  const lease = await dependencies.acquireThreadSandbox(ctx, {
    snapshot: options.snapshot,
    chip: options.chip,
    warmPool: options.warmPool,
    labels: options.labels,
    requiredLabels: options.requiredLabels,
  });
  endSandbox?.();

  const endPrepare = ctx.timing?.begin(`${options.timingPrefix}.prepare`);
  let providerState: T | undefined;
  let providerPrepared = false;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      if (providerPrepared && options.closeProvider) {
        await options.closeProvider(providerState as T);
      }
    } finally {
      if (lease.releaseAfterRun) await lease.sandbox.delete().catch(() => {});
    }
  };
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
    if (options.prepareSandbox) {
      await stage("sandbox_fence", () => options.prepareSandbox!(sandbox, lease.binding));
    }
    const runtimeLayout = sandboxRuntimeLayout(lease.binding.kind);
    const workdir = await stage("workspace_root", () =>
      resolveRuntimeWorkspaceRoot(sandbox, runtimeLayout)
    );
    const resourceUser = typeof options.resourceUser === "function"
      ? options.resourceUser(lease.binding)
      : options.resourceUser;
    if (resourceUser) {
      const owned = await stage("workspace_owner", () => sandbox.process.executeCommand(
        `command -v setfacl >/dev/null && ` +
          `setfacl -m u:${resourceUser.uid}:x /root && ` +
          `chown root:root ${shq(workdir)} && chmod 1777 ${shq(workdir)}`,
        undefined,
        undefined,
        10,
      ));
      if ((owned.exitCode ?? 1) !== 0) {
        throw new Error("failed to prepare lower-privilege workspace owner");
      }
    }
    await stage("secrets", () =>
      materializeSecretInjection(
        (command) => sandbox.process.executeCommand(command, undefined, undefined, 30),
        secretInjection,
      ),
    );
    const prepareStableProvider = options.prepareStableProvider;
    if (!lease.reused && prepareStableProvider) {
      await stage("provider_bootstrap", () =>
        prepareStableProvider(sandbox, workdir, lease.binding)
      );
      ctx.signal.throwIfAborted();
    }
    const prepareResources = async () => {
      const [changedRepoPaths] = await Promise.all([
        stage("repos", async () => {
          const changed = await prepareRepos(sandbox, workdir, ctx, runtimeLayout);
          const pullRequests = await checkoutPullRequestResources(
            sandbox,
            workdir,
            ctx.resolvedResources ?? [],
            ctx,
            runtimeLayout,
          );
          return [...new Set([...changed, ...pullRequests])];
        }),
        stage("inputs", () => materializeRunInputs(sandbox, ctx, resourceUser)),
      ]);
      if (resourceUser && changedRepoPaths.length > 0) {
        const markers = changedRepoPaths.map((path) => {
          const marker = shq(runtimeUserOwnershipMarker(path, runtimeLayout));
          return `printf 'uid=%s gid=%s\n' ${resourceUser.uid} ${resourceUser.gid} > ${marker} && chmod 600 ${marker}`;
        });
        const transferred = await stage("repo_owner", () => sandbox.process.executeCommand(
          `install -d -m 700 /root/.skynet/repo-runtime-ownership && ` +
            `find ${changedRepoPaths.map(shq).join(" ")} -xdev -depth -exec chown -h ${resourceUser.uid}:${resourceUser.gid} -- {} + && ` +
            markers.join(" && "),
          undefined,
          undefined,
          30,
        ));
        if ((transferred.exitCode ?? 1) !== 0) {
          throw new Error("failed to transfer prepared repositories to runtime user");
        }
      }
    };
    const prepareProvider = () => stage("provider_bridge", async () => {
      const state = await options.prepareProvider(sandbox, workdir, lease.binding);
      providerState = state;
      providerPrepared = true;
      return state;
    });
    let resolvedProviderState: T;
    if (
      options.providerAfterResources ||
      (!lease.reused && options.prepareStableProvider)
    ) {
      await prepareResources();
      ctx.signal.throwIfAborted();
      resolvedProviderState = await prepareProvider();
    } else {
      const providerOperation = prepareProvider();
      const resourcesOperation = prepareResources();
      try {
        [resolvedProviderState] = await Promise.all([providerOperation, resourcesOperation]);
      } catch (error) {
        await Promise.allSettled([providerOperation, resourcesOperation]);
        throw error;
      }
    }
    await stage("secrets_marker", () => recordSecretsInjected(ctx, secretInjection));
    return {
      sandbox,
      workdir,
      providerState: resolvedProviderState,
      redact,
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  } finally {
    endPrepare?.();
  }
}
