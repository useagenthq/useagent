// Implements the ported a peer tool Transport contract (see connectors/types.ts).
// a peer tool ships Slack/Telegram surfaces; email is a NEW useAgent surface that
// subclasses the same ABCs — the subclassing pattern is modeled on
// src/kiro_crew/slack/transport.py + telegram/transport.py (deny-by-default
// allow-list, held-and-exposed client, Tier-1 core + inbound adapter).

import { AllowList } from "../authorize";
import type { ConnectorEmailConfig } from "../../env";
import { EMAIL_CAPABILITIES } from "./capabilities";
import type {
  ConfiguredChannelTarget,
  InboundMessage,
  Transport,
  TransportCapabilities,
} from "../types";
import { sendSmtp } from "./smtp";

/** A fully-addressed outbound email (the email surface's native send shape). */
export interface OutboundEmail {
  to: string[];
  subject: string;
  text: string;
}

/** Hard cap on a single SMTP dialog so a stalled server can't wedge a run's
 *  completion path. The dry-run path never opens a socket. */
const SMTP_TIMEOUT_MS = 20_000;

export class EmailTransport implements Transport {
  readonly channelType = "email";
  readonly capabilities: TransportCapabilities = EMAIL_CAPABILITIES;

  readonly #config: ConnectorEmailConfig;
  // Deny-by-default outbound allow-list: we only ever deliver to configured
  // recipients, frozen at construction. Ports the transport allow-list model.
  readonly #recipients: AllowList;

  constructor(config: ConnectorEmailConfig) {
    this.#config = config;
    this.#recipients = new AllowList(config.to);
  }

  // -- Channel-specific rich delivery (used by EmailRenderer) -------------
  /** Deliver `msg` to its allow-listed recipients. In dry-run, logs the fully
   *  rendered payload instead of sending (credentials are never logged). */
  async deliver(msg: OutboundEmail): Promise<string> {
    const allowed = msg.to.filter((r) => this.#recipients.authorize(r));
    if (allowed.length === 0) {
      console.warn(
        `[connectors/email] no allow-listed recipients in [${msg.to.join(", ")}] — nothing sent`,
      );
      return "";
    }

    if (this.#config.dryRun) {
      console.log(
        [
          "[connectors/email] DRY-RUN would send:",
          `  from:    ${this.#config.from}`,
          `  to:      ${allowed.join(", ")}`,
          `  subject: ${msg.subject}`,
          "  --- body ---",
          msg.text
            .split("\n")
            .map((l) => `  ${l}`)
            .join("\n"),
          "  --- end ---",
        ].join("\n"),
      );
      return "dry-run";
    }

    await Promise.race([
      sendSmtp(
        {
          host: this.#config.host,
          port: this.#config.port,
          secure: this.#config.secure,
          user: this.#config.user,
          pass: this.#config.pass,
        },
        { from: this.#config.from, to: allowed, subject: msg.subject, text: msg.text },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SMTP timeout")), SMTP_TIMEOUT_MS),
      ),
    ]);
    console.log(
      `[connectors/email] sent "${msg.subject}" → ${allowed.join(", ")}`,
    );
    return allowed.join(",");
  }

  // -- Tier-1 core --------------------------------------------------------
  async sendMessage(
    conversationId: string,
    content: string,
    _threadId?: string | null,
  ): Promise<string> {
    // Generic contract: the first non-empty line becomes the subject, the whole
    // content the body. Rich callers use deliver() with an explicit subject.
    const nl = content.indexOf("\n");
    const subject =
      (nl === -1 ? content : content.slice(0, nl)).trim() || "useAgent notification";
    return this.deliver({ to: [conversationId], subject, text: content });
  }

  async resolveConversation(userId: string): Promise<string> {
    // An email address is its own conversation id.
    return userId;
  }

  async fetchHistory(): Promise<InboundMessage[]> {
    // v1 is outbound-only; there is no IMAP history reader.
    return [];
  }

  configuredTargets(): ConfiguredChannelTarget[] {
    return this.#recipients.values().map((addr) => ({
      targetId: `email:${addr}`,
      label: `Email · ${addr}`,
      available: true,
      unavailableReason: "",
    }));
  }

  // -- Inbound adapter ----------------------------------------------------
  // Email is OUTBOUND-only in v1, so deny-by-default is the literal correct
  // answer: nobody can drive a turn via email and no envelope is processed.
  authorize(_msg: InboundMessage): boolean {
    return false;
  }

  async receive(_rawEnvelope: unknown): Promise<void> {
    /* no inbound in v1 */
  }
}
