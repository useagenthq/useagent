import { shq } from "./repo-prep";

const PRESEEDED_PROVIDER_BIN_DIR = "/usr/local/share/skynet-provider-bin";
const RUNTIME_ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const HOME_RUNTIME_PATH_RE = /^\$HOME(?:\/[A-Za-z0-9._-]+)+$/;

/** Build the per-sandbox package install clause. Idempotency keys on the
 * actual install path because base images can expose a different binary on PATH. */
export function buildAcpInstallClause(packages: { pkg: string; bin: string }[]): string {
  return packages
    .map(({ pkg, bin }) => {
      const seeded = `${PRESEEDED_PROVIDER_BIN_DIR}/${bin}`;
      return (
        `[ -x "$HOME/.local/bin/${bin}" ] || { mkdir -p "$HOME/.local/bin"; ` +
        `if [ -x "${seeded}" ]; then ln -sfn "${seeded}" "$HOME/.local/bin/${bin}"; ` +
        `else npm install -g --prefix $HOME/.local --silent "${pkg}" >/dev/null 2>&1; fi; }; `
      );
    })
    .join("");
}

/** Explicit exports for the resident ACP relay. Gateway endpoints are
 * regenerated on every control-plane boot and override durable sandbox env. */
export function buildAcpRuntimeEnvExports(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([name, value]) => {
      if (!RUNTIME_ENV_NAME_RE.test(name)) {
        throw new Error(`invalid ACP runtime environment name: ${name}`);
      }
      const rendered = HOME_RUNTIME_PATH_RE.test(value) ? `"${value}"` : shq(value);
      return `export ${name}=${rendered}; `;
    })
    .join("");
}

/** Apply a per-turn Codex model choice to an already-resident ACP session. */
export function codexModelSelectionRequest(
  engine: string,
  sessionId: string,
  model: string,
): {
  method: "session/set_config_option";
  params: { configId: "model"; sessionId: string; value: string };
} | null {
  if (engine !== "codex" || !model.trim()) return null;
  return {
    method: "session/set_config_option",
    params: { configId: "model", sessionId, value: model },
  };
}
