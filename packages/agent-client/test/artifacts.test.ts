import { describe, expect, test } from "bun:test";
import { createAgentClient, decodeArtifactList } from "../src";
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
};

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
});
