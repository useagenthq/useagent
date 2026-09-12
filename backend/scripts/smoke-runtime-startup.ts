// Smoke test: how long does a fresh sandbox on one provider take to reach a ready
// native runtime? It performs the same steps a run performs on a new sandbox
// (create, workspace root, bun + the codex/claude/opencode bootstrap, the runtime
// server boot, the Pi runtime) and prints one line per step. One sandbox is
// created and deleted; nothing else is touched.
//
//   bun run scripts/smoke-runtime-startup.ts --provider cube|daytona|box [--snapshot NAME] [--user ORG_ID:USER_ID]
//
// `--user` resolves the Box connection of that user exactly like a run does
// (USER_COMPUTERS); without it the provider's env credential is used.
import { readFile } from "node:fs/promises";
import { ensurePiRuntimeInstalled } from "../src/engines/pi-runtime-config";
import { runtimeRunSnapshot } from "../src/engines/runtime-adapter";
import {
  ensureRuntimeEnvironment,
  resolveRuntimeWorkspaceRoot,
} from "../src/engines/runtime-environment";
import { prewarmRuntimeProviderBridge } from "../src/engines/runtime-provider-bridge";
import { resolveSandboxBindingForRun } from "../src/sandboxes/binding";
import {
  sandboxProviderApiKeyFor,
  sandboxProviderFor,
  sandboxRuntimeLayout,
} from "../src/sandboxes/provider";
import { isSandboxProviderKind } from "../src/sandboxes/plugins";
import { assertSandboxResources } from "../src/engines/daytona-resources";
import { desktopToolchainProbeCommand } from "../src/sandboxes/native-image";
import type { SandboxHandle, SandboxProvider } from "../src/sandboxes/provider";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const steps: { step: string; ms: number }[] = [];
async function timed<T>(step: string, work: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    const ms = Math.round(performance.now() - startedAt);
    steps.push({ step, ms });
    console.log(`${step.padEnd(28)} ${String(ms).padStart(7)} ms`);
  }
}

async function main(): Promise<void> {
  const kind = argument("provider");
  if (!kind || !isSandboxProviderKind(kind)) throw new Error("--provider cube|daytona|box is required");
  const user = argument("user");
  const env = { ...process.env, SANDBOX_PROVIDER: kind, RUNTIME_ENVIRONMENT_ENABLED: "true" };
  let provider: SandboxProvider;
  let snapshot: string;
  if (user) {
    const [orgId, userId] = user.split(":");
    if (!orgId || !userId) throw new Error("--user takes ORG_ID:USER_ID");
    const binding = await resolveSandboxBindingForRun({ orgId, userId });
    if (binding.kind !== kind) throw new Error(`user ${userId} resolves to ${binding.kind}, not ${kind}`);
    provider = binding.provider;
    snapshot = argument("snapshot") ?? binding.snapshot ?? "";
    console.log(`provider ${kind} (${binding.credential} credential), snapshot ${snapshot || "<base image>"}`);
  } else {
    const apiKey = sandboxProviderApiKeyFor(kind, env);
    if (apiKey === undefined) throw new Error(`no env credential for ${kind}`);
    provider = sandboxProviderFor(kind, apiKey, env);
    snapshot = argument("snapshot") ?? runtimeRunSnapshot(env);
    console.log(`provider ${kind} (env credential), snapshot ${snapshot || "<base image>"}`);
  }
  const layout = sandboxRuntimeLayout(kind);
  const signal = AbortSignal.timeout(10 * 60_000);
  const total = performance.now();
  const sandbox: SandboxHandle = await timed("sandbox.create", () =>
    provider.create({
      ...(snapshot ? { snapshot } : {}),
      labels: { "useagent.purpose": "smoke-runtime-startup" },
      autoStopInterval: 10,
      autoDeleteInterval: 30,
    }),
  );
  console.log(`sandbox ${sandbox.id}`);
  try {
    assertSandboxResources(sandbox);
    const desktop = await timed("desktop.dependencies", () =>
      sandbox.process.executeCommand(desktopToolchainProbeCommand(), undefined, undefined, 20));
    if ((desktop.exitCode ?? 1) !== 0) throw new Error("image is missing required desktop dependencies");
    await timed("workspace.root", () => resolveRuntimeWorkspaceRoot(sandbox, layout));
    await timed("bridge.bun+drivers", () => prewarmRuntimeProviderBridge(sandbox, env));
    await timed("runtime.boot", () => ensureRuntimeEnvironment(sandbox, signal));
    if (sandbox.fs) {
      const runtimeRoot = layout.runsAsRoot ? "/opt/useagent/pi-runtime" : `${layout.home}/.useagent/pi-runtime`;
      const runtimeManifestDir = `${runtimeRoot}/manifest`;
      const manifests = process.env.PI_MANIFEST_DIR ?? new URL("../pi-runtime", import.meta.url).pathname;
      await timed("pi.runtime", async () => {
        await sandbox.process.executeCommand(`install -d -m 755 '${runtimeManifestDir}'`, undefined, undefined, 20);
        await sandbox.fs!.uploadFile(await readFile(`${manifests}/package.json`), `${runtimeManifestDir}/package.json`);
        await sandbox.fs!.uploadFile(await readFile(`${manifests}/package-lock.json`), `${runtimeManifestDir}/package-lock.json`);
        await ensurePiRuntimeInstalled({
          process: sandbox.process,
          runtimeRoot,
          runtimeManifestDir,
          bunExecutable: layout.bunExecutable ?? "/usr/local/bin/bun",
          executable: `${runtimeRoot}/current/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`,
        });
      });
    }
    const documents = await sandbox.process.executeCommand("command -v soffice >/dev/null && python3 -c 'import reportlab, xlsxwriter, openpyxl, pptx'", undefined, undefined, 20);
    if ((documents.exitCode ?? 1) !== 0) throw new Error("image is missing required document dependencies");
    console.log("document toolchain            ready");
  } finally {
    await timed("sandbox.delete", () => sandbox.delete());
  }
  const elapsed = Math.round(performance.now() - total);
  console.log(`total (create to runtime ready, excluding delete) ${elapsed - (steps.at(-1)?.ms ?? 0)} ms`);
}

main().catch((error) => {
  console.error(`[smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
