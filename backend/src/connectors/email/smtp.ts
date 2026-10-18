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

  const write = (line: string): void => {
    live.write(`${line}\r\n`);
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
    const from = msg.fromName ? `"${msg.fromName.replace(/["\r\n]/g, "")}" <${msg.from}>` : msg.from;
    const boundary = `=_useagent_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const headers = [
      `From: ${from}`,
      `To: ${msg.to.join(", ")}`,
      `Subject: ${msg.subject}`,
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
