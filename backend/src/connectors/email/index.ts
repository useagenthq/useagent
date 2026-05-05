// Email connector: on every spawned run, attach an EmailRenderer that digests the
// run and (per the notify policy) delivers a completion email. Env-gated by
// connectorEmailConfig() — this module is only started when that returns non-null.

import type { ConnectorEmailConfig } from "../../env";
import { bus, RUN_SPAWNED } from "../../worker";
import { attachRunFeed } from "../runFeed";
import { EmailRenderer } from "./renderer";
import { EmailTransport } from "./transport";

export { EmailTransport } from "./transport";
export { EmailRenderer } from "./renderer";
export { renderEmail } from "./render";
export { EMAIL_CAPABILITIES } from "./capabilities";

/**
 * Start the email connector. Subscribes to the global run-spawned signal and, for
 * each run, attaches a fresh EmailRenderer via the shared run-feed. Returns a
 * stop() that detaches the boot hook (used by tests; the process otherwise runs
 * it for its lifetime). One EmailTransport is shared (stateless besides config);
 * a Renderer is per-run (it accumulates run-specific output).
 */
export function startEmailConnector(config: ConnectorEmailConfig): () => void {
  const transport = new EmailTransport(config);

  const onSpawned = (runId: string): void => {
    try {
      const renderer = new EmailRenderer({ runId, transport, config });
      attachRunFeed(runId, renderer);
    } catch (err) {
      console.error(
        `[connectors/email] failed to attach feed for run ${runId}:`,
        err,
      );
    }
  };

  bus.on(RUN_SPAWNED, onSpawned);
  return () => bus.off(RUN_SPAWNED, onSpawned);
}
