import { afterEach, describe, expect, test } from "bun:test";
import server from "../src/index";
import { publishOrgChange, publishRunLifecycleChange } from "../src/runs/org-signals";
import { BASE, ORIGIN, createOrgSession, waitFor } from "./helpers";

interface OpenChanges {
  readonly response: Response;
  readonly changes: unknown[];
  close(): Promise<void>;
}

async function openChanges(cookies: string): Promise<OpenChanges> {
  const controller = new AbortController();
  const response = await server.fetch(new Request(`${BASE}/api/runs/changes`, {
    headers: { cookie: cookies, origin: ORIGIN },
    signal: controller.signal,
  }));
  const changes: unknown[] = [];
  const reader = response.body?.getReader() ?? null;
  const pump = (async () => {
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data:"));
          if (data) changes.push(JSON.parse(data.slice(5).trim()));
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Expected when close aborts the request.
    }
  })();
  return {
    response,
    changes,
    async close() {
      controller.abort();
      await reader?.cancel().catch(() => {});
      await pump.catch(() => {});
    },
  };
}

const opened: OpenChanges[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

describe("org changes stream", () => {
  test("keeps legacy unscoped lifecycle publications off every org stream", async () => {
    const org = await createOrgSession("changes-legacy");
    const stream = await openChanges(org.cookies);
    opened.push(stream);

    publishRunLifecycleChange({
      orgId: null,
      threadId: "legacy-thread",
      runId: "legacy-run",
      kind: "settled",
    });

    await Bun.sleep(20);
    expect(stream.changes).toEqual([]);
  });

  test("streams run and artifact invalidations only to the authorized org", async () => {
    const orgA = await createOrgSession("changes-a");
    const orgB = await createOrgSession("changes-b");
    const streamA = await openChanges(orgA.cookies);
    const streamB = await openChanges(orgB.cookies);
    opened.push(streamA, streamB);

    expect(streamA.response.status).toBe(200);
    expect(streamA.response.headers.get("content-type")).toContain("text/event-stream");
    expect(streamA.response.headers.get("cache-control")).toContain("no-transform");
    expect(streamA.response.headers.get("x-accel-buffering")).toBe("no");

    publishRunLifecycleChange({
      orgId: orgA.orgId,
      threadId: "thread-a",
      runId: "run-a",
      kind: "running",
    });
    publishOrgChange(orgA.orgId, {
      type: "artifact",
      action: "created",
      artifactId: "artifact-a",
      runId: "run-a",
      threadId: "thread-a",
    });

    await waitFor(async () => streamA.changes.length === 2);
    expect(streamA.changes).toEqual([
      {
        type: "run",
        action: "running",
        runId: "run-a",
        threadId: "thread-a",
      },
      {
        type: "artifact",
        action: "created",
        artifactId: "artifact-a",
        runId: "run-a",
        threadId: "thread-a",
      },
    ]);
    expect(streamB.changes).toEqual([]);
  });
});
