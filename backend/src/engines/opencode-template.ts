import type { SandboxBinding } from "../sandboxes/binding";
import { rememberPreparedProviderSnapshot } from "../provider-connections/service";
import { OPENCODE_VERSION } from "./opencode-serve";

const TEMPLATE_NAME = `useagent-opencode-${OPENCODE_VERSION.replaceAll(".", "-")}`;
const preparations = new Map<string, Promise<void>>();

async function prepareTemplate(
  scope: { readonly orgId: string; readonly userId: string },
  binding: SandboxBinding,
): Promise<void> {
  const source = await binding.provider.create({
    labels: { "useagent.template": TEMPLATE_NAME },
    autoDeleteInterval: 60,
  });
  try {
    const installed = await source.process.executeCommand(
      `set -eu; mkdir -p "$HOME/.local/bin"; ` +
        `bun add --global opencode-ai@${OPENCODE_VERSION}; ` +
        `test -x "$HOME/.bun/bin/opencode"; ` +
        `ln -sf "$HOME/.bun/bin/opencode" "$HOME/.local/bin/opencode"; ` +
        `"$HOME/.local/bin/opencode" --version`,
      undefined,
      undefined,
      180,
    );
    if ((installed.exitCode ?? 1) !== 0) {
      throw new Error("OpenCode template runtime installation failed");
    }
    const status = await binding.provider.saveTemplate!(source.id, TEMPLATE_NAME);
    if (status.state !== "active") {
      throw new Error(status.detail ?? "OpenCode template did not become ready");
    }
    await rememberPreparedProviderSnapshot({
      ...scope,
      provider: "box",
      snapshotName: TEMPLATE_NAME,
      expectedUpdatedAt: binding.connectionUpdatedAt!,
    });
  } finally {
    await source.delete().catch(() => {});
  }
}

/** Prepare a clean per-account Box template outside the user's run latency. */
export function scheduleOpenCodeTemplatePreparation(
  scope: { readonly orgId?: string | null; readonly userId?: string | null },
  binding: SandboxBinding,
): void {
  if (
    binding.kind !== "box" ||
    binding.credential !== "user" ||
    binding.snapshot ||
    !scope.orgId ||
    !scope.userId ||
    !binding.connectionUpdatedAt ||
    !binding.provider.saveTemplate
  ) return;

  const key = `${scope.orgId}\0${scope.userId}`;
  if (preparations.has(key)) return;
  const task = prepareTemplate({ orgId: scope.orgId, userId: scope.userId }, binding)
    .catch((error) => {
      console.warn(
        "[opencode] Box runtime template preparation failed:",
        error instanceof Error ? error.message : error,
      );
    })
    .finally(() => {
      preparations.delete(key);
    });
  preparations.set(key, task);
}
