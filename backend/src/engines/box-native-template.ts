// Box has no image build: a template is a live box frozen as a named snapshot,
// and named snapshots belong to the account whose key created them. Runs on a
// user's Box connection therefore need the native image baked under that
// user's own key. `bakeBoxNativeSnapshot` is an explicit operator action only;
// normal runs and the default weekly job never create a billed bake Box.
import type { SandboxProvider } from "@useagent/sandbox-contract";
import { claudeProviderGatewayEnvironment } from "../provider-gateway/sandbox-config";
import {
  applyNativeImage,
  deploymentNativeImageName,
  isNativeImageName,
  loadNativeImageInputs,
  nativeImageName,
  type NativeImageInputs,
} from "../sandboxes/native-image";
import { sandboxRuntimeLayout } from "../sandboxes/provider";
import { RUNTIME_ENGINE_VERSIONS } from "./runtime-provider-bridge";

/** The earlier opencode-only Box template; still recognised so those boxes skip the npx bootstrap. */
export const OPENCODE_TEMPLATE_NAME = `useagent-opencode-${RUNTIME_ENGINE_VERSIONS.opencode.replaceAll(".", "-")}`;
const BAKE_TIMEOUT_MS = 40 * 60_000;
// Absolute Box TTL for the bake box, longer than the bake itself: an interrupted
// bake (backend restart, lost network) can never leave a box running for good.
const BAKE_BOX_TTL_MINUTES = 60;

/** True when new boxes from this snapshot need no opencode bootstrap. */
export function boxTemplateHasOpenCode(snapshot: string | null | undefined): boolean {
  return snapshot === OPENCODE_TEMPLATE_NAME || isNativeImageName(snapshot);
}

/** The native image name for this deployment's inputs (the Claude driver needs the gateway). */
export const boxNativeSnapshotName = deploymentNativeImageName;

let cachedInputs: Promise<NativeImageInputs> | undefined;
function nativeImageInputs(): Promise<NativeImageInputs> {
  cachedInputs ??= loadNativeImageInputs(claudeProviderGatewayEnvironment()).catch((error) => {
    cachedInputs = undefined;
    throw error;
  });
  return cachedInputs;
}

export interface BoxNativeSnapshotResult {
  readonly name: string;
  /** "reused" when the account already had the current image. */
  readonly outcome: "baked" | "reused";
}

/** Bake the native image under `provider`'s account and freeze it as a named snapshot. */
export async function bakeBoxNativeSnapshot(
  provider: SandboxProvider,
  options: {
    /** A user's own custom snapshot to build on; null starts from Box's base image. */
    readonly base: string | null;
    readonly force?: boolean;
    readonly inputs?: NativeImageInputs;
    readonly signal?: AbortSignal;
    readonly log?: (line: string) => void;
  },
): Promise<BoxNativeSnapshotResult> {
  if (!provider.saveTemplate || !provider.ensureTemplate) {
    throw new Error("this provider cannot save named snapshots");
  }
  const inputs = options.inputs ?? (await nativeImageInputs());
  const name = nativeImageName(inputs);
  const log = options.log ?? (() => {});
  const signal = options.signal ?? AbortSignal.timeout(BAKE_TIMEOUT_MS);
  const existing = await provider.ensureTemplate(name);
  if (existing.state === "active" && !options.force) {
    log(`${name} already exists`);
    return { name, outcome: "reused" };
  }
  if (existing.state !== "absent") {
    if (!provider.deleteTemplate) throw new Error(`${name} exists (${existing.state}) and this provider cannot replace it`);
    await provider.deleteTemplate(name);
    log(`removed the previous ${name} (${existing.state})`);
  }
  const layout = sandboxRuntimeLayout("box");
  const sandbox = await provider.create({
    ...(options.base ? { snapshot: options.base } : {}),
    labels: { "useagent.purpose": "native-image-bake", "useagent.native-image": name },
    autoDeleteInterval: BAKE_BOX_TTL_MINUTES,
  });
  log(`baking ${name} in ${sandbox.id}${options.base ? ` from ${options.base}` : ""}`);
  try {
    await applyNativeImage(sandbox, layout, inputs, { signal, log });
    const status = await provider.saveTemplate(sandbox.id, name);
    if (status.state !== "active") {
      throw new Error(`${name} did not become ready: ${status.detail ?? status.state}`);
    }
    log(`${name} saved`);
    return { name, outcome: "baked" };
  } finally {
    await sandbox.delete().catch(() => {});
  }
}

/** A user's connection is ours to advance when it has no snapshot or one we named. */
export function boxConnectionAcceptsNativeSnapshot(snapshot: string | null | undefined): boolean {
  return !snapshot || snapshot === OPENCODE_TEMPLATE_NAME || isNativeImageName(snapshot);
}
