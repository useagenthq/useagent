import type { SandboxProviderKind } from "@useagent/sandbox-contract";
import { daytonaPlugin } from "@useagent/sandbox-daytona";
import { sandboxProviderKind } from "../sandboxes/provider";
import { operatorEnv } from "./runtime-env";
import { runtimeGeneration } from "./runtime-environment";

/**
 * The template a runtime-lane sandbox starts from on a given provider: the
 * deployment's default provider unless a kind is named (a member's preferred
 * provider gets its own template, never the default provider's, since a
 * Daytona snapshot name means nothing to Cube or Box).
 */
export function runtimeRunSnapshot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  kind: SandboxProviderKind = sandboxProviderKind(env),
): string {
  if (kind === "cube") {
    const runtimeTemplate = operatorEnv(
      env,
      "RUNTIME_CUBE_TEMPLATE_ID",
      "T3_CUBE_TEMPLATE_ID",
    )?.trim();
    const generation = runtimeGeneration(env);
    if (generation !== runtimeGeneration({}) && !runtimeTemplate) {
      throw new Error(
        `Runtime generation ${generation} requires a dedicated RUNTIME_CUBE_TEMPLATE_ID; refusing to relabel CUBE_TEMPLATE_ID`,
      );
    }
    const template = runtimeTemplate || env.CUBE_TEMPLATE_ID?.trim();
    if (!template) {
      throw new Error(
        "RUNTIME_CUBE_TEMPLATE_ID (legacy T3_CUBE_TEMPLATE_ID) is required for the Cube runtime adapter",
      );
    }
    return template;
  }
  if (kind === "box") {
    // The baked native snapshot (bun, the runtime, every provider driver, Pi,
    // the document toolchain) wins over the generic Box template; "" is Box's
    // base image, which installs all of that on every fresh run.
    return (
      operatorEnv(env, "RUNTIME_BOX_SNAPSHOT", "T3_BOX_SNAPSHOT")?.trim() ||
      env.BOX_SNAPSHOT?.trim() ||
      ""
    );
  }
  return (
    operatorEnv(env, "RUNTIME_DAYTONA_SNAPSHOT", "T3_DAYTONA_SNAPSHOT")?.trim() ||
    daytonaPlugin.template(env)
  );
}
