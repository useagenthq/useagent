// Minimal SMTP client over Bun's raw TCP (`Bun.connect`). NOT a KiroCrew port —
// KiroCrew's email path uses provider SDKs; this is original, written for
// useAgent's "no new heavyweight deps" constraint (nodemailer et al. pull a large
// tree). It speaks just enough SMTP to deliver a plain-text message:
//
//   greeting → EHLO → [AUTH LOGIN] → MAIL FROM → RCPT TO(×n) → DATA → body → QUIT
//
// Supported: implicit TLS (port 465 / `secure`) and plaintext (e.g. a local
// MailHog catcher on 1025), with optional AUTH LOGIN. NOT supported (deferred):
// STARTTLS upgrade on port 587 — point `secure`/465 at a provider that offers
// implicit TLS, or run a local catcher, for the real-send path. The dry-run path
// (transport.ts) needs none of this.

export interface SmtpConfig {
  host: string;
  port: number;
  /** Longest the whole dialog may take; on expiry the socket is closed and the send rejects. */
  timeoutMs?: number;
  secure: boolean;
  user?: string;
  pass?: string;
}

export interface SmtpMessage {
  from: string;
  /** Display name for the From header; the envelope sender stays the bare address. */
  fromName?: string;
  to: string[];
  subject: string;
  text: string;
  /** Optional HTML alternative; the plain text is always sent alongside it. */
  html?: string;
}

/** The most UTF-8 bytes one encoded word carries: 45 bytes are 60 base64
 *  characters, which with the "=?UTF-8?B?" and "?=" around them stay inside
 *  the 75 characters RFC 2047 allows a word. */
const ENCODED_WORD_BYTES = 45;
/** Longer plain text is encoded too, so the folded words keep every header line
 *  under the 998 characters a relay accepts. */
const PLAIN_HEADER_MAX = 900;

/**
 * Header text as an SMTP relay may carry it. Printable ASCII goes as typed;
 * anything else (an accented or emoji name, a control character, a line too
 * long for one header line) becomes RFC 2047 encoded words of UTF-8, one per
 * folded line, each cut on a character boundary. Without it a relay or client
 * that is not told the header's charset shows the name garbled, and a long
 * subject breaks the line limit.
 */
function encodeHeaderText(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value) && !value.includes("=?") && value.length <= PLAIN_HEADER_MAX) return value;
  const words: string[] = [];
  let word = "";
  for (const char of value) {
    if (word && Buffer.byteLength(word + char) > ENCODED_WORD_BYTES) {
      words.push(word);
      word = "";
    }
    word += char;
  }
  if (word) words.push(word);
  return words.map((text) => `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`).join("\r\n ");
}

/** The From header: a display name quoted when it is plain ASCII, encoded otherwise. */
function fromHeader(address: string, name: string | undefined): string {
  const display = name?.replace(/["\r\n]/g, "");
  if (!display) return address;
  const encoded = encodeHeaderText(display);
  return `${encoded === display ? `"${display}"` : encoded} <${address}>`;
}

/** A Message-ID under the sender's own domain, as RFC 5322 asks of every message. */
function messageId(from: string): string {
  const domain = from.slice(from.lastIndexOf("@") + 1);
  return `<${crypto.randomUUID()}@${/^[a-z0-9.-]+$/i.test(domain) ? domain : "localhost"}>`;
}

export async function sendSmtp(cfg: SmtpConfig, msg: SmtpMessage): Promise<void> {
  let buffer = "";
  let onData: (() => void) | null = null;
  // A closed or timed-out socket ends every pending read instead of parking it.
  let failure: Error | null = null;
  const fail = (error: Error) => {
    failure ??= error;
    const wake = onData;
    onData = null;
    wake?.();
  };

  // One deadline covers connecting and the whole dialog. The connect attempt
  // itself cannot be aborted, so it is raced against the deadline and a socket
  // that arrives after it has fired is dropped on the spot.
  let rejectConnect: ((error: Error) => void) | null = null;
  const expired = new Promise<never>((_, reject) => {
    rejectConnect = reject;
  });
  expired.catch(() => {}); // observed through the race below, or not at all
  let socket: Awaited<ReturnType<typeof Bun.connect>> | null = null;

  // Bun's socket.write hands the kernel only what fits in its send buffer and
  // returns that many bytes; it keeps nothing back. The bytes it did not take
  // wait here and go out on each `drain`, so a long message reaches the relay
  // whole instead of losing its tail and the "." that ends it.
  let unsent = new Uint8Array(0);
  const flush = (): void => {
    if (!socket || unsent.byteLength === 0) return;
    const written = socket.write(unsent);
    if (written > 0) unsent = unsent.subarray(written);
  };

  const deadline = cfg.timeoutMs
    ? setTimeout(() => {
        const error = new Error("SMTP timeout");
        fail(error);
        rejectConnect?.(error);
        socket?.terminate();
      }, cfg.timeoutMs)
    : undefined;
  try {
    const connecting = Bun.connect({
      hostname: cfg.host,
      port: cfg.port,
      tls: cfg.secure,
      socket: {
        data(_s, data) {
          buffer += data.toString();
          const wake = onData;
          onData = null;
          wake?.();
        },
        drain() {
          flush();
        },
        error(_s, error) {
          fail(error instanceof Error ? error : new Error("SMTP socket error"));
        },
        close() {
          fail(new Error("SMTP connection closed"));
        },
      },
    });
    connecting.then(
      (late) => {
        if (failure) late.terminate();
      },
      () => {},
    );
    socket = await (deadline ? Promise.race([connecting, expired]) : connecting);
  } catch (error) {
    clearTimeout(deadline);
    throw failure ?? error;
  }
  if (failure) {
    clearTimeout(deadline);
    socket.terminate();
    throw failure;
  }
  const live = socket;

  // Read one complete SMTP reply (handles multiline "250-foo\r\n250 bar").
  const readReply = async (): Promise<{ code: number; text: string }> => {
    for (;;) {
      const lines = buffer.split("\r\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // A terminal reply line has a space (not '-') in position 3.
        if (line.length >= 4 && line[3] === " ") {
          const code = Number(line.slice(0, 3));
          buffer = lines.slice(i + 1).join("\r\n");
          return { code, text: line.slice(4) };
        }
      }
      if (failure) throw failure;
      await new Promise<void>((resolve) => {
        onData = resolve;
      });
      if (failure) throw failure;
    }
  };

  const encoder = new TextEncoder();
  const write = (line: string): void => {
    const bytes = encoder.encode(`${line}\r\n`);
    if (unsent.byteLength === 0) {
      unsent = bytes;
    } else {
      const queued = new Uint8Array(unsent.byteLength + bytes.byteLength);
      queued.set(unsent);
      queued.set(bytes, unsent.byteLength);
      unsent = queued;
    }
    flush();
  };
  const expect = async (family: number): Promise<void> => {
    const reply = await readReply();
    if (Math.floor(reply.code / 100) !== Math.floor(family / 100)) {
      throw new Error(`SMTP ${reply.code}: ${reply.text}`);
    }
  };

  try {
    await expect(220); // server greeting
    write("EHLO useagent");
    await expect(250);

    if (cfg.user && cfg.pass) {
      write("AUTH LOGIN");
      await expect(334);
      write(btoa(cfg.user));
      await expect(334);
      write(btoa(cfg.pass));
      await expect(235);
    }

    write(`MAIL FROM:<${msg.from}>`);
    await expect(250);
    for (const rcpt of msg.to) {
      write(`RCPT TO:<${rcpt}>`);
      await expect(250);
    }

    write("DATA");
    await expect(354);
    const boundary = `=_useagent_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const headers = [
      `Date: ${new Date().toUTCString().replace(/GMT$/, "+0000")}`,
      `Message-ID: ${messageId(msg.from)}`,
      `From: ${fromHeader(msg.from, msg.fromName)}`,
      `To: ${msg.to.join(", ")}`,
      `Subject: ${encodeHeaderText(msg.subject)}`,
      "MIME-Version: 1.0",
      msg.html ? `Content-Type: multipart/alternative; boundary="${boundary}"` : 'Content-Type: text/plain; charset="utf-8"',
    ].join("\r\n");
    const raw = msg.html
      ? [
          `--${boundary}`,
          'Content-Type: text/plain; charset="utf-8"',
          "",
          msg.text,
          `--${boundary}`,
          'Content-Type: text/html; charset="utf-8"',
          "",
          msg.html,
          `--${boundary}--`,
        ].join("\n")
      : msg.text;
    // CRLF newlines + dot-stuffing (a line starting with "." is escaped to "..").
    const body = raw.replace(/\r?\n/g, "\r\n").replace(/(^|\r\n)\./g, "$1..");
    write(`${headers}\r\n\r\n${body}\r\n.`);
    await expect(250);

    write("QUIT");
    await readReply().catch(() => {}); // some servers close before the 221
  } finally {
    clearTimeout(deadline);
    live.end();
  }
}
