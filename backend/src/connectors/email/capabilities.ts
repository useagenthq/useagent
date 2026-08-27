// Ported from a peer tool (Apache-2.0): src/kiro_crew/messaging/transport.py (TransportCapabilities)
import { defaultCapabilities, type TransportCapabilities } from "../types";

/** Email surface capabilities. v1 is a single plain-text, outbound message: no
 *  streaming/edit/reactions/rich-blocks/threads, no interactive buttons, and an
 *  effectively unbounded body (we never chunk an email). */
export const EMAIL_CAPABILITIES: TransportCapabilities = defaultCapabilities({
  streaming: false,
  edit: false,
  reactions: false,
  files: false,
  richBlocks: false,
  threads: false,
  maxMessageChars: 10_000_000,
  maxButtons: 0,
  supportsProactiveSend: true,
});
