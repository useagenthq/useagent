import { describe, expect, test } from "bun:test";
import {
  artifactWorkpieceExports,
  createAgentClient,
  decodeArtifactList,
  decodeArtifactResult,
  decodeWorkpieceResult,
} from "../src";
import type { FetchLike, ResponseLike } from "../src/api";

const descriptor = {
  id: "artifact-1",
  run_id: "run-1",
  thread_id: "thread-1",
  name: "report.pdf",
  source_path: "/workspace/report.pdf",
  content_type: "application/pdf",
  size_bytes: 42,
  sha256: "a".repeat(64),
  created_at: "2026-08-10T00:00:00.000Z",
  preview_url: "/api/artifacts/artifact-1/content",
  download_url: "/api/artifacts/artifact-1/content?download=1",
  workpiece: null,
};

const workpiece = {
  kind: "document",
  source_version: "a".repeat(64),
  state_revision: 2,
  state_url: "/api/artifacts/artifact-1/workpiece",
  export_url: "/api/artifacts/artifact-1/workpiece/export",
  exports: artifactWorkpieceExports("document"),
  actions: ["preview", "download", "edit", "export"],
} as const;

const legacyWorkpiece = {
  kind: "document",
  source_version: "a".repeat(64),
  state_revision: 2,
  state_url: "/api/artifacts/artifact-1/workpiece",
  actions: ["preview", "download", "edit"],
} as const;

function jsonResponse(body: unknown): ResponseLike {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("artifact client contract", () => {
  test("rejects partial descriptors at the package boundary", () => {
    expect(decodeArtifactList({ artifacts: [descriptor] })).toEqual([descriptor]);
    expect(decodeArtifactList({ artifacts: [{ ...descriptor, sha256: null }] })).toBeNull();
  });

  test("decodes artifact and workpiece API envelopes", () => {
    expect(decodeArtifactResult({ artifact: descriptor, created: true })).toEqual({
      artifact: descriptor,
      created: true,
    });
    expect(decodeArtifactResult({ artifact: descriptor, created: "yes" })).toBeNull();
    expect(decodeWorkpieceResult({ workpiece, state: { html: "<h1>Brief</h1>" } })).toEqual({
      workpiece,
      state: { html: "<h1>Brief</h1>" },
    });
    expect(decodeWorkpieceResult({ workpiece, state: { csv: "wrong" } })).toBeNull();
  });

  test("keeps artifact lists available across old and new workpiece metadata", () => {
    const decoded = decodeArtifactList({
      artifacts: [
        { ...descriptor, id: "legacy", workpiece: legacyWorkpiece },
        {
          ...descriptor,
          id: "transitional",
          workpiece: {
            ...workpiece,
            actions: legacyWorkpiece.actions,
          },
        },
        { ...descriptor, id: "current", workpiece },
        {
          ...descriptor,
          id: "partial",
          workpiece: {
            ...workpiece,
            export_url: undefined,
            exports: undefined,
          },
        },
      ],
    });

    expect(decoded).not.toBeNull();
    expect(decoded?.[0]?.workpiece).toEqual(legacyWorkpiece);
    expect(decoded?.[1]?.workpiece).toEqual(workpiece);
    expect(decoded?.[2]?.workpiece).toEqual(workpiece);
    expect(decoded?.[3]?.workpiece).toMatchObject({
      kind: "document",
      actions: ["preview", "download", "edit"],
    });
    expect(decoded?.[3]?.workpiece).not.toHaveProperty("export_url");
    expect(decoded?.[3]?.workpiece).not.toHaveProperty("exports");
  });

  test("ignores unknown additive actions instead of rejecting a durable descriptor", () => {
    const decoded = decodeArtifactList({
      artifacts: [{
        ...descriptor,
        workpiece: {
          ...workpiece,
          actions: [...workpiece.actions, "future-action"],
        },
      }],
    });

    expect(decoded?.[0]?.workpiece?.actions).toEqual([
      "preview",
      "download",
      "edit",
      "export",
    ]);
  });

  test("owns artifact wire decoders outside the workspace domain package", async () => {
    const workspace = await import("../../artifact-workspace/src");
    expect(workspace).not.toHaveProperty("decodeArtifact");
    expect(workspace).not.toHaveProperty("decodeWorkpieceResult");
  });

  test("lists artifacts with encoded filters", async () => {
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      return jsonResponse({ artifacts: [descriptor] });
    };
    const client = createAgentClient({ fetch, baseUrl: "https://skynet.test" });
    expect(await client.listArtifacts({ threadId: "thread/1" })).toEqual([descriptor]);
    expect(calls).toEqual(["https://skynet.test/api/artifacts?thread_id=thread%2F1"]);
  });

  test("classifies malformed artifact responses as decode errors", async () => {
    const client = createAgentClient({ fetch: async () => jsonResponse({ artifacts: [{}] }) });
    await expect(client.listArtifacts()).rejects.toMatchObject({ code: "decode_error" });
  });

  test("round-trips typed workpiece state and optimistic revisions", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, body: init?.body });
      return jsonResponse({ workpiece, state: { text: "updated" } });
    };
    const client = createAgentClient({ fetch });
    expect(await client.getArtifactWorkpiece("artifact-1")).toEqual({
      workpiece,
      state: { text: "updated" },
    });
    expect(await client.updateArtifactWorkpiece("artifact-1", 2, { text: "updated" })).toEqual({
      workpiece,
      state: { text: "updated" },
    });
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
      expected_revision: 2,
      state: { text: "updated" },
    });
  });

  test("accepts sanitized rich document state for browser Office companions", async () => {
    const client = createAgentClient({
      fetch: async () => jsonResponse({ workpiece, state: { html: "<h1>Brief</h1>" } }),
    });
    expect(await client.getArtifactWorkpiece("artifact-1")).toEqual({
      workpiece,
      state: { html: "<h1>Brief</h1>" },
    });
  });

  test("rejects a workpiece state that does not match its registered kind", async () => {
    const client = createAgentClient({
      fetch: async () => jsonResponse({ workpiece, state: { csv: "wrong shape" } }),
    });
    await expect(client.getArtifactWorkpiece("artifact-1")).rejects.toMatchObject({
      code: "decode_error",
    });
  });
});
