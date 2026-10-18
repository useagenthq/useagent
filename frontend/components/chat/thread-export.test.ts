import { describe, expect, mock, test } from "bun:test";
import { marked } from "marked";
import type { StoredCanonicalEvent } from "./canonical-timeline";
import type { NativeFrame } from "./native-events";
import {
  downloadThreadExport,
  formatThreadJson,
  formatThreadMarkdown,
  type ThreadExportData,
} from "./thread-export";
import { createThreadStore, type ThreadSnapshot } from "./thread-store";
import type { ApiRun, ApiStep } from "./types";
import { PLATFORM_EVENT_LANES } from "@useagent/agent-harness/canonical";

const ORIGIN = "https://app.example.test";

function run(
  id: string,
  prompt: string,
  summary: string | null = null,
  steps: ApiStep[] = [],
): ApiRun {
  return {
    id,
    org_id: "org-1",
    user_id: null,
    parent_run_id: null,
    child_session: false,
    thread_id: "r1",
    prompt,
    summary,
    status: "completed",
    engine: "opencode",
    model: "model-1",
    duration_ms: null,
    engine_session_id: null,
    sandbox_id: null,
    repo: null,
    repos: [],
    repo_specs: [],
    resolved_resources: [],
    skill_id: null,
    skill_version: null,
    skill_content_hash: null,
    uploads: [],
    memory_scope: "org",
    created_at: "2030-01-01T00:00:00Z",
    updated_at: "2030-01-01T00:00:00Z",
    steps,
  };
}

function step(tool: string, input: Record<string, unknown>, idx = 0): ApiStep {
  return {
    id: `s${idx}`,
    run_id: "r1",
    idx,
    kind: "command",
    label: "Execute",
    chip: null,
    code_json: JSON.stringify({ tool, input, output: "Large tool result stays in JSON." }),
    created_at: "2030-01-01T00:00:00Z",
  };
}

function frame(
  seq: number,
  eventType: string,
  payload: unknown,
  provider = "opencode",
): NativeFrame {
  return {
    schemaVersion: 1,
    eventId: `e${seq}`,
    seq,
    provider,
    eventType,
    native: {
      sessionId: "ses-1",
      parentSessionId: null,
      messageId: "m1",
      partId: `p${seq}`,
      callId: null,
    },
    payload,
  };
}

function data(snapshot: ThreadSnapshot): ThreadExportData {
  return {
    threadId: "r1",
    snapshot,
    turns: snapshot.runs.map((row) => {
      const view = snapshot.byId.get(row.id);
      if (!view) throw new Error(`Missing test run ${row.id}`);
      return {
        run: row,
        steps: view.native.steps,
        status: view.status,
        summary: view.summary,
        live: view.status === "running",
        liveText: view.liveText,
        liveReasoning: view.liveReasoning,
        native: view.native,
        canonical: view.canonical,
        canonicalComplete: view.canonicalComplete,
      };
    }),
  };
}

describe("thread Markdown export", () => {
  test("exports multiple messages in order, followed by short tool and target lines", () => {
    const store = createThreadStore();
    store.applySnapshot([
      run("r1", "检查 **报告**", "## Findings\n\nAll good.", [
        step("read", { filePath: "src/report.ts" }),
        step("bash", { command: "bun test\ncomponents" }, 1),
      ]),
      run("r2", "What changed?", "Updated `report.ts`."),
    ]);
    const markdown = formatThreadMarkdown(data(store.getSnapshot()), ORIGIN);
    const html = marked.parse(markdown, { async: false });
    expect(html).toContain("检查 <strong>报告</strong>");
    expect(html).toContain("<h2>Findings</h2>");
    expect(html).toContain("<code>read</code>: <code>src/report.ts</code>");
    expect(html).toContain("<code>bash</code>: <code>bun test components</code>");
    expect(markdown.indexOf("All good.")).toBeLessThan(markdown.indexOf("### Steps"));
    expect(markdown.indexOf("### Steps")).toBeLessThan(markdown.indexOf("What changed?"));
    expect(markdown).not.toContain("Large tool result");
  });

  test("keeps native narration and a terminal reply once, then durable artifact links", () => {
    const store = createThreadStore();
    store.applySnapshot([run("r1", "Build a report", "Final answer.")]);
    store.applyNative("r1", frame(0, "part.step-start", {}));
    store.applyNative("r1", frame(1, "part.text", { text: "First message." }));
    store.applyNative("r1", frame(2, "part.text", { text: "Final answer." }));
    const descriptor = {
      id: "artifact/1",
      name: "report [final].md",
      size_bytes: 12,
      sha256: "a".repeat(64),
      content_type: "text/markdown",
    };
    store.applyNative("r1", frame(3, "artifact.created", descriptor, PLATFORM_EVENT_LANES.platform));
    store.applyNative(
      "r1",
      frame(4, "artifact.delivered", { ...descriptor, destination: "email" }, PLATFORM_EVENT_LANES.platform),
    );
    const markdown = formatThreadMarkdown(data(store.getSnapshot()), ORIGIN);
    const html = marked.parse(markdown, { async: false });
    expect(markdown.match(/Final answer\./g)).toHaveLength(1);
    expect(markdown.indexOf("First message.")).toBeLessThan(markdown.indexOf("Final answer."));
    expect(markdown.indexOf("Final answer.")).toBeLessThan(markdown.indexOf("### Files"));
    expect(html).toContain(
      'href="https://app.example.test/api/artifacts/artifact%2F1/content?download=1"',
    );
    expect(html).toContain(">report [final].md</a>");
    expect(markdown.match(/report \\\[final\\\]\.md/g)).toHaveLength(1);
  });

  test("falls back to live text and labels a snapshot taken during a running turn", () => {
    const store = createThreadStore();
    store.applySnapshot([{ ...run("r1", "Explain this"), status: "running" }]);
    store.applyDelta("r1", "Still writing…\n\n第二段");
    const markdown = formatThreadMarkdown(data(store.getSnapshot()), ORIGIN);
    expect(markdown).toContain("### Assistant\n\nStill writing…\n\n第二段");
    expect(markdown).toContain("This turn is still in progress.");
  });

  test("uses completed canonical data only when enabled, and links immutable file diffs", () => {
    const store = createThreadStore();
    store.applySnapshot([run("r1", "Update the report", "Updated.")]);
    const event: StoredCanonicalEvent = {
      schemaVersion: 1,
      eventId: "file-1",
      runId: "r1",
      threadId: "r1",
      deliverySeq: 1,
      revision: 1,
      seq: 1,
      kind: "file.changed",
      path: "src/a`b.ts",
      changeType: "edit",
      diff: { artifactId: "diff-1", bytes: 12, sha256: "b".repeat(64), contentType: "text/x-diff" },
    };
    store.applyCanonical(event);
    expect(formatThreadMarkdown(data(store.getSnapshot()), ORIGIN, true)).not.toContain(
      "### Files",
    );
    store.markCanonicalComplete("r1");
    const exported = data(store.getSnapshot());
    expect(formatThreadMarkdown(exported, ORIGIN)).not.toContain("### Files");
    const html = marked.parse(formatThreadMarkdown(exported, ORIGIN, true), { async: false });
    expect(html).toContain("<code>src/a`b.ts</code>");
    expect(html).toContain(
      'href="https://app.example.test/api/artifacts/diff-1/content?download=1"',
    );
    expect(html).not.toContain('href="src/');
  });

  test("marks unloaded history without inventing its messages or steps", () => {
    const store = createThreadStore();
    store.applySnapshot([run("r1", "Loaded", "Answer")]);
    const loaded = data(store.getSnapshot());
    const exported: ThreadExportData = {
      ...loaded,
      turns: [
        {
          ...loaded.turns[0],
          run: run("unloaded", "Placeholder"),
          pendingOutline: { stepCount: 10, hasSummary: true },
        },
        ...loaded.turns,
      ],
    };
    const markdown = formatThreadMarkdown(exported, ORIGIN);
    expect(markdown).toContain("includes loaded history only");
    expect(markdown).toContain("This turn's messages and steps have not been loaded.");
    expect(markdown).not.toContain("Placeholder");
    expect(markdown.match(/### User/g)).toHaveLength(1);
    expect(JSON.parse(formatThreadJson(exported)).unloadedRunIds).toEqual(["unloaded"]);
  });
});

describe("thread JSON export", () => {
  test("preserves raw steps, native and provisional canonical events, and transient buffers", () => {
    const store = createThreadStore();
    const original = {
      ...run("r1", "Raw **prompt**", null, [step("read", { filePath: "src/a.ts" })]),
      status: "running" as const,
    };
    const native = frame(2, "unknown.provider.event", {
      nested: [1, { content: "原始数据\n```" }],
    });
    const canonical: StoredCanonicalEvent = {
      schemaVersion: 1,
      eventId: "canonical-1",
      runId: "r1",
      threadId: "r1",
      deliverySeq: 3,
      revision: 2,
      seq: 3,
      kind: "unknown.canonical.event",
      rawPayload: { result: "Keep this byte-for-byte string.\n" },
    };
    store.applySnapshot([original]);
    store.applyNative("r1", native);
    store.applyCanonical(canonical);
    store.applyDelta("r1", "Live text");
    store.applyDelta("r1", "Live reasoning", "reasoning");
    const snapshot = store.getSnapshot();
    const json = JSON.parse(formatThreadJson(data(snapshot)));
    expect(json.runs).toEqual(snapshot.runs);
    expect(json.events[0].steps).toEqual(original.steps);
    expect(json.events[0].nativeFrames).toEqual([native]);
    expect(json.events[0].canonicalEvents).toEqual([canonical]);
    expect(json.events[0]).toMatchObject({
      liveText: "Live text",
      liveReasoning: "Live reasoning",
      canonicalComplete: false,
    });
    expect(snapshot.byId.get("r1")?.native.nativeFrames[0]).toBe(native);
  });
});

describe("thread export download", () => {
  test("downloads UTF-8 blobs with the selected extension and releases the object URL", async () => {
    const previousDocument = globalThis.document;
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    const blobs: Blob[] = [];
    const links: {
      href: string;
      download: string;
      click: ReturnType<typeof mock>;
      remove: ReturnType<typeof mock>;
    }[] = [];
    const revoke = mock(() => {});
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return `blob:export-${blobs.length}`;
    };
    URL.revokeObjectURL = revoke;
    globalThis.document = {
      body: { append: mock(() => {}) },
      createElement: () => {
        const link = { href: "", download: "", click: mock(() => {}), remove: mock(() => {}) };
        links.push(link);
        return link;
      },
    } as unknown as Document;
    try {
      downloadThreadExport("# 报告\n", "r1", "markdown");
      downloadThreadExport('{"text":"报告"}\n', "r1", "json");
      expect(links.map((link) => link.download)).toEqual(["thread-r1.md", "thread-r1.json"]);
      expect(blobs.map((blob) => blob.type)).toEqual([
        "text/markdown;charset=utf-8",
        "application/json;charset=utf-8",
      ]);
      expect(await blobs[0].text()).toBe("# 报告\n");
      expect(JSON.parse(await blobs[1].text())).toEqual({ text: "报告" });
      for (const link of links) {
        expect(link.click).toHaveBeenCalledTimes(1);
        expect(link.remove).toHaveBeenCalledTimes(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(revoke.mock.calls).toEqual([["blob:export-1"], ["blob:export-2"]]);
    } finally {
      globalThis.document = previousDocument;
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  });
});
