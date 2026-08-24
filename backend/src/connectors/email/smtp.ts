// Minimal SMTP client over Bun's raw TCP (`Bun.connect`). NOT a reference bot port —
// reference bot's email path uses provider SDKs; this is original, written for
// Skynet's "no new heavyweight deps" constraint (nodemailer et al. pull a large
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
  secure: boolean;
  user?: string;
  pass?: string;
}

export interface SmtpMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

export async function sendSmtp(cfg: SmtpConfig, msg: SmtpMessage): Promise<void> {
  let buffer = "";
  let onData: (() => void) | null = null;

  const socket = await Bun.connect({
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
      error() {
        /* surfaced by a stalled readReply / the deliver() timeout */
      },
      close() {
        const wake = onData;
        onData = null;
        wake?.();
      },
    },
  });

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
      await new Promise<void>((resolve) => {
        onData = resolve;
      });
    }
  };

  const write = (line: string): void => {
    socket.write(`${line}\r\n`);
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
    const headers = [
      `From: ${msg.from}`,
      `To: ${msg.to.join(", ")}`,
      `Subject: ${msg.subject}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="utf-8"',
    ].join("\r\n");
    // CRLF newlines + dot-stuffing (a line starting with "." is escaped to "..").
    const body = msg.text
      .replace(/\r?\n/g, "\r\n")
      .replace(/(^|\r\n)\./g, "$1..");
    write(`${headers}\r\n\r\n${body}\r\n.`);
    await expect(250);

    write("QUIT");
    await readReply().catch(() => {}); // some servers close before the 221
  } finally {
    socket.end();
  }
}
