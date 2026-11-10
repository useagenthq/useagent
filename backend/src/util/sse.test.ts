import { describe, expect, spyOn, test } from "bun:test";
import { SSE_HEARTBEAT_MS, sseResponse } from "./sse";

/** Read raw text off the response until `until` returns true or the body ends. */
async function readUntil(res: Response, until: (text: string) => boolean): Promise<{ text: string; done: boolean }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    if (until(text)) {
      reader.releaseLock();
      return { text, done: false };
    }
    const { value, done } = await reader.read();
    if (done) return { text, done: true };
    text += decoder.decode(value, { stream: true });
  }
}

async function readAll(res: Response): Promise<string> {
  return (await readUntil(res, () => false)).text;
}

describe("sseResponse", () => {
  test("sends the four anti-buffering headers and the opening comment", async () => {
    const res = sseResponse({ signal: new AbortController().signal }, (stream) => {
      stream.close();
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("connection")).toBe("keep-alive");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect([...res.headers.keys()].sort()).toEqual([
      "cache-control",
      "connection",
      "content-type",
      "x-accel-buffering",
    ]);
    expect(await readAll(res)).toBe(": open\n\n");
  });

  test("puts the reconnect delay in the opening comment", async () => {
    const res = sseResponse({ signal: new AbortController().signal, retryMs: 1500 }, (stream) => {
      stream.close();
    });
    expect(await readAll(res)).toBe(": open\nretry: 1500\n\n");
  });

  test("sendEvent writes event and JSON data, and send writes a frame as given", async () => {
    const res = sseResponse({ signal: new AbortController().signal }, (stream) => {
      stream.sendEvent("step", { idx: 0, text: "a\nb" });
      stream.send(": comment\n\n");
      stream.close();
    });
    expect(await readAll(res)).toBe(
      ': open\n\nevent: step\ndata: {"idx":0,"text":"a\\nb"}\n\n: comment\n\n',
    );
  });

  test("heartbeats an idle stream and clears the timer when closed", async () => {
    expect(SSE_HEARTBEAT_MS).toBe(25_000);
    const started = spyOn(globalThis, "setInterval");
    const cleared = spyOn(globalThis, "clearInterval");
    try {
      let close!: () => void;
      const res = sseResponse({ signal: new AbortController().signal, heartbeatMs: 5 }, (stream) => {
        close = stream.close;
      });
      expect(started).toHaveBeenCalledTimes(1);
      expect(started.mock.calls[0]?.[1]).toBe(5);
      const handle = started.mock.results[0]?.value as ReturnType<typeof setInterval>;
      const { text } = await readUntil(res, (t) => t.split(": ping\n\n").length > 2);
      expect(text.startsWith(": open\n\n: ping\n\n: ping\n\n")).toBe(true);
      expect(cleared).not.toHaveBeenCalled();
      close();
      // The interval itself is cleared, not just its frames dropped.
      expect(cleared).toHaveBeenCalledTimes(1);
      expect(cleared.mock.calls[0]?.[0]).toBe(handle);
      const rest = await readAll(res);
      // Everything after the close is the tail already buffered, then the end of the body.
      expect(rest.replaceAll(": ping\n\n", "")).toBe("");
    } finally {
      started.mockRestore();
      cleared.mockRestore();
    }
  });

  test("a route that throws while starting leaves no timer or abort hook behind", () => {
    const cleared = spyOn(globalThis, "clearInterval");
    const controller = new AbortController();
    try {
      expect(() =>
        sseResponse({ signal: controller.signal }, () => {
          throw new Error("route failed");
        }),
      ).toThrow("route failed");
      expect(cleared).toHaveBeenCalledTimes(1);
    } finally {
      cleared.mockRestore();
    }
  });

  test("aborting the request runs the teardown once and ends the body", async () => {
    const controller = new AbortController();
    let torn = 0;
    let stream!: { closed: boolean; sendEvent(event: string, data: unknown): void };
    const res = sseResponse({ signal: controller.signal }, (s) => {
      stream = s;
      return () => {
        torn += 1;
      };
    });
    expect(stream.closed).toBe(false);
    controller.abort();
    expect(stream.closed).toBe(true);
    expect(torn).toBe(1);
    controller.abort();
    stream.sendEvent("late", {});
    expect(torn).toBe(1);
    const { text, done } = await readUntil(res, () => false);
    expect(done).toBe(true);
    expect(text).toBe(": open\n\n");
  });

  test("a request that is already gone never starts the route", async () => {
    const controller = new AbortController();
    controller.abort();
    let started = false;
    const res = sseResponse({ signal: controller.signal }, () => {
      started = true;
    });
    expect(started).toBe(false);
    expect((await readUntil(res, () => false)).done).toBe(true);
  });

  test("close is idempotent and a write after it is dropped", async () => {
    let torn = 0;
    const res = sseResponse({ signal: new AbortController().signal }, (stream) => {
      stream.sendEvent("one", 1);
      stream.close();
      stream.close();
      stream.sendEvent("two", 2);
      return () => {
        torn += 1;
      };
    });
    expect(torn).toBe(1);
    expect(await readAll(res)).toBe(": open\n\nevent: one\ndata: 1\n\n");
  });

  test("a client cancelling the body closes the stream and runs the teardown", async () => {
    let torn = 0;
    let stream!: { closed: boolean };
    const res = sseResponse({ signal: new AbortController().signal }, (s) => {
      stream = s;
      return () => {
        torn += 1;
      };
    });
    await res.body!.cancel();
    expect(stream.closed).toBe(true);
    expect(torn).toBe(1);
  });
});

describe("the stream literals live in one place", () => {
  test("the heartbeat interval and the full header block appear only in util/sse.ts", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const root = join(import.meta.dir, "..");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (abs.endsWith(".ts") && !abs.endsWith(".test.ts")) files.push(abs);
      }
    };
    walk(root);
    const heartbeat: string[] = [];
    const headers: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (text.includes("25_000")) heartbeat.push(relative(root, file));
      if (text.includes("text/event-stream; charset=utf-8")) headers.push(relative(root, file));
    }
    // A new stream goes through sseResponse; a new 25 s wait reuses SSE_HEARTBEAT_MS
    // or gets its own named constant.
    expect(heartbeat).toEqual(["util/sse.ts"]);
    expect(headers).toEqual(["util/sse.ts"]);
  });
});
