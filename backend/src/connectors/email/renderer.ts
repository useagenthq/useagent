// Ported from reference bot (Apache-2.0): src/kiro_crew/messaging/renderer.py (Renderer contract)
// Ported from reference bot (Apache-2.0): src/kiro_crew/slack/renderer.py (accumulate → flush shape)
//
// The email Renderer: accumulates a run's output events during the turn, then on
// onDone reads the durable run row for the final summary/status and delivers a
// single digest email (subject + steps + assistant output) via EmailTransport.

import { getRun } from "../../runs/repo";
import type { RunStatus } from "../../db/schema";
import type { ConnectorEmailConfig } from "../../env";
import type { Renderer } from "../types";
import { renderEmail, type RenderedLine } from "./render";
import type { EmailTransport } from "./transport";

export class EmailRenderer implements Renderer {
  readonly channelType = "email";

  readonly #runId: string;
  readonly #transport: EmailTransport;
  readonly #config: ConnectorEmailConfig;
  readonly #lines: RenderedLine[] = [];
  readonly #textParts: string[] = [];

  constructor(opts: {
    runId: string;
    transport: EmailTransport;
    config: ConnectorEmailConfig;
  }) {
    this.#runId = opts.runId;
    this.#transport = opts.transport;
    this.#config = opts.config;
  }

  onTextChunk(text: string): void {
    if (text) this.#textParts.push(text);
  }

  onThinking(text: string): void {
    if (text) this.#lines.push({ type: "thinking", text });
  }

  onToolCall(_toolCallId: string, title: string, toolKind = ""): void {
    this.#lines.push({ type: "tool", text: title, toolKind: toolKind || undefined });
  }

  onCompaction(): void {
    /* context compaction is not surfaced in the v1 email digest */
  }

  async onDone(stopReason = ""): Promise<void> {
    const status = (stopReason || "completed") as RunStatus;
    // notify=failed → deliver only on failure; notify=all → always deliver.
    if (this.#config.notify === "failed" && status !== "failed") return;

    // The `end` event is emitted AFTER completeRun persists the summary, so the
    // row is authoritative here (also covers the already-terminal race path).
    const run = await getRun(this.#runId);
    if (!run) return;

    const { subject, text } = renderEmail({
      runId: this.#runId,
      prompt: run.prompt,
      engine: run.engine,
      status: run.status,
      summary: run.summary,
      durationMs: run.durationMs,
      lines: this.#lines,
      assistantText: this.#textParts.join(""),
    });

    await this.#transport.deliver({ to: this.#config.to, subject, text });
  }
}
