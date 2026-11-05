import { describe, expect, test } from "bun:test";
import { sendSmtp } from "../src/connectors/email/smtp";

// The wire form of a message: the envelope keeps the bare address, the header
// carries the display name, and an HTML alternative travels next to the text.

async function capture(msg: Parameters<typeof sendSmtp>[1]): Promise<string> {
  let inData = false;
  let data = "";
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.write("220 test\r\n");
      },
      data(s, chunk) {
        const text = chunk.toString();
        if (inData) {
          data += text;
          if (data.includes("\r\n.\r\n")) {
            inData = false;
            s.write("250 queued\r\n");
          }
          return;
        }
        for (const line of text.split("\r\n").filter(Boolean)) {
          if (line.startsWith("DATA")) {
            inData = true;
            s.write("354 go\r\n");
          } else if (line.startsWith("QUIT")) s.write("221 bye\r\n");
          else if (line.startsWith("EHLO")) s.write("250-test\r\n250 OK\r\n");
          else s.write(`250 OK ${line}\r\n`);
        }
      },
    },
  });
  try {
    await sendSmtp({ host: "127.0.0.1", port: server.port, secure: false, timeoutMs: 2_000 }, msg);
  } finally {
    server.stop(true);
  }
  return data;
}

describe("smtp message form", () => {
  test("a display name goes in the From header only, and html rides as a multipart alternative", async () => {
    const wire = await capture({
      from: "noreply@example.test",
      fromName: 'Use"Agent\r\nX-Injected: 1',
      to: ["new@example.test"],
      subject: "hi",
      text: "plain\n.leading dot",
      html: "<p>rich</p>",
    });
    expect(wire).toContain('From: "UseAgentX-Injected: 1" <noreply@example.test>\r\n');
    expect(wire).toMatch(/Content-Type: multipart\/alternative; boundary="[^"]+"\r\n/);
    expect(wire).toContain('Content-Type: text/plain; charset="utf-8"\r\n\r\nplain\r\n..leading dot\r\n');
    expect(wire).toContain('Content-Type: text/html; charset="utf-8"\r\n\r\n<p>rich</p>\r\n');
    expect(wire).toMatch(/--=_useagent_[a-z0-9]+--\r\n\.\r\n$/);
  });

  test("without html the message is plain text with a bare From, as before", async () => {
    const wire = await capture({ from: "noreply@example.test", to: ["new@example.test"], subject: "hi", text: "plain" });
    expect(wire).toContain("From: noreply@example.test\r\n");
    expect(wire).toContain('Content-Type: text/plain; charset="utf-8"\r\n\r\nplain\r\n.\r\n');
    expect(wire).not.toContain("multipart");
  });

  test("every message carries a Date and a Message-ID under the sender's domain", async () => {
    const before = Math.floor(Date.now() / 1000) * 1000;
    const wire = await capture({ from: "noreply@mail.example.test", to: ["new@example.test"], subject: "hi", text: "plain" });
    const date = /^Date: ((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2}) \+0000\r$/m.exec(wire);
    expect(date).not.toBeNull();
    const sent = Date.parse(`${date![1]} GMT`);
    expect(sent).toBeGreaterThanOrEqual(before);
    expect(sent).toBeLessThanOrEqual(Date.now());
    expect(wire).toMatch(/^Message-ID: <[0-9a-f-]{36}@mail\.example\.test>\r$/m);
    const second = await capture({ from: "noreply@mail.example.test", to: ["new@example.test"], subject: "hi", text: "plain" });
    expect(/^Message-ID: (.+)\r$/m.exec(second)![1]).not.toBe(/^Message-ID: (.+)\r$/m.exec(wire)![1]);
  });

  test("a plain ASCII subject goes as typed", async () => {
    const wire = await capture({ from: "noreply@example.test", to: ["new@example.test"], subject: "Ada invited you to Acme on UseAgent", text: "plain" });
    expect(wire).toContain("\r\nSubject: Ada invited you to Acme on UseAgent\r\n");
  });

  test("a subject and display name outside ASCII go as encoded words that decode back", async () => {
    const subject = "Zoë Šimková invited you to Café Ñandú 東京チーム 🙂 on UseAgent";
    const wire = await capture({ from: "noreply@example.test", fromName: "Équipe UseAgent", to: ["new@example.test"], subject, text: "plain" });
    const headers = wire.slice(0, wire.indexOf("\r\n\r\n"));
    expect(/^[\x00-\x7f]*$/.test(headers)).toBe(true);
    expect(decodeHeader(headerValue(headers, "Subject"))).toBe(subject);
    const from = headerValue(headers, "From");
    expect(from).toEndWith(" <noreply@example.test>");
    expect(decodeHeader(from.slice(0, -" <noreply@example.test>".length))).toBe("Équipe UseAgent");
    for (const word of headers.match(/=\?UTF-8\?B\?[^?]*\?=/g) ?? []) expect(word.length).toBeLessThanOrEqual(75);
  });

  test("a subject too long for one header line is folded under the line limit", async () => {
    const subject = `Run completed - ${"a long first line of the answer ".repeat(80)}`.trim();
    const wire = await capture({ from: "noreply@example.test", to: ["new@example.test"], subject, text: "plain" });
    const headers = wire.slice(0, wire.indexOf("\r\n\r\n"));
    for (const line of headers.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
    expect(decodeHeader(headerValue(headers, "Subject"))).toBe(subject);
  });

  test("a carriage return in a subject cannot start a header of its own", async () => {
    const wire = await capture({ from: "noreply@example.test", to: ["new@example.test"], subject: "hi\rBcc: someone@example.test", text: "plain" });
    const headers = wire.slice(0, wire.indexOf("\r\n\r\n"));
    expect(headers).not.toMatch(/^Bcc:/m);
    expect(decodeHeader(headerValue(headers, "Subject"))).toBe("hi\rBcc: someone@example.test");
  });

  test("a message larger than the socket's send buffer reaches the relay whole", async () => {
    // Far more than one socket write hands the kernel (Linux's default send
    // buffer tops out at 4 MiB), in multibyte text so a partial write can end
    // inside a character.
    const line = "Grüße, 東京 🙂 the agent's long answer goes on\n";
    const text = line.repeat(Math.ceil((16 * 1024 * 1024) / Buffer.byteLength(line)));
    const chunks: Uint8Array[] = [];
    let inData = false;
    let tail = "";
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(s) {
          s.write("220 test\r\n");
        },
        data(s, chunk) {
          if (inData) {
            chunks.push(new Uint8Array(chunk));
            tail = (tail + chunk.toString("latin1")).slice(-5);
            if (tail === "\r\n.\r\n") {
              inData = false;
              s.write("250 queued\r\n");
            }
            return;
          }
          const command = chunk.toString();
          if (command.startsWith("DATA")) {
            inData = true;
            s.write("354 go\r\n");
          } else if (command.startsWith("QUIT")) s.write("221 bye\r\n");
          else if (command.startsWith("EHLO")) s.write("250-test\r\n250 OK\r\n");
          else s.write("250 OK\r\n");
        },
      },
    });
    try {
      await sendSmtp(
        { host: "127.0.0.1", port: server.port, secure: false, timeoutMs: 10_000 },
        { from: "noreply@example.test", to: ["new@example.test"], subject: "hi", text },
      );
    } finally {
      server.stop(true);
    }
    const wire = Buffer.concat(chunks).toString("utf8");
    const body = `${text.replace(/\n/g, "\r\n")}\r\n.\r\n`;
    expect(wire.endsWith(body)).toBe(true);
    expect(wire.slice(0, -body.length)).toEndWith('Content-Type: text/plain; charset="utf-8"\r\n\r\n');
  });
});

/** One header's value with its folded continuation lines joined back up. */
function headerValue(headers: string, name: string): string {
  const match = new RegExp(`^${name}: (.*(?:\r\n[ \t].*)*)`, "m").exec(headers);
  if (!match) throw new Error(`no ${name} header`);
  return match[1]!.replace(/\r\n[ \t]/g, " ");
}

/** RFC 2047 B-encoded UTF-8 words back to text; whitespace between words drops. */
function decodeHeader(value: string): string {
  if (!value.includes("=?")) return value;
  const words = value.trim().split(/\s+/);
  const bytes = words.map((word) => {
    const match = /^=\?UTF-8\?B\?([^?]*)\?=$/.exec(word);
    if (!match) throw new Error(`not an encoded word: ${word}`);
    return Buffer.from(match[1]!, "base64");
  });
  return Buffer.concat(bytes).toString("utf8");
}
