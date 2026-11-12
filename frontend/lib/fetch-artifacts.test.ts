import { describe, expect, test } from "bun:test";
import type { ArtifactDescriptor } from "@/components/artifacts/model";
import {
  appendOlderPage,
  artifactPagePath,
  mergeNewestPage,
  readArtifactPage,
} from "./fetch-artifacts";

function artifact(id: string): ArtifactDescriptor {
  return {
    id,
    run_id: "r1",
    thread_id: "t1",
    name: `${id}.txt`,
    source_path: `/root/work/${id}.txt`,
    content_type: "text/plain",
    size_bytes: 1,
    sha256: "abc",
    created_at: "2026-01-01T00:00:00Z",
    preview_url: `/api/artifacts/${id}/content`,
    download_url: `/api/artifacts/${id}/content?download=1`,
    preview_pdf_url: null,
    workpiece: null,
  };
}

const ids = (list: readonly ArtifactDescriptor[]) => list.map((item) => item.id);

describe("artifact pages", () => {
  test("asks for the newest page, or the page after a cursor", () => {
    expect(artifactPagePath()).toBe("/api/artifacts");
    expect(artifactPagePath("eyJ2IjoxfQ")).toBe("/api/artifacts?cursor=eyJ2IjoxfQ");
    expect(artifactPagePath("a+b/c=")).toBe("/api/artifacts?cursor=a%2Bb%2Fc%3D");
  });

  test("reads the cursor, and a missing or malformed one as the last page", () => {
    const artifacts = [artifact("a1")];
    expect(readArtifactPage({ artifacts, has_more: true, next_cursor: "c1" })).toEqual({
      artifacts,
      nextCursor: "c1",
    });
    expect(readArtifactPage({ artifacts })).toEqual({ artifacts, nextCursor: null });
    expect(readArtifactPage({ artifacts, next_cursor: "" })).toEqual({
      artifacts,
      nextCursor: null,
    });
    expect(readArtifactPage({ artifacts, next_cursor: 7 })).toEqual({
      artifacts,
      nextCursor: null,
    });
    expect(readArtifactPage({ next_cursor: "c1" })).toBeNull();
    expect(readArtifactPage(null)).toBeNull();
  });

  test("a refreshed newest page leads, and loaded files it no longer holds follow in order", () => {
    const loaded = [artifact("a1"), artifact("a2"), artifact("a3"), artifact("a4")];
    expect(ids(mergeNewestPage([artifact("a0"), artifact("a1"), artifact("a2")], loaded))).toEqual([
      "a0",
      "a1",
      "a2",
      "a3",
      "a4",
    ]);
    expect(ids(mergeNewestPage([], loaded))).toEqual(["a1", "a2", "a3", "a4"]);
  });

  test("an older page is added after what is loaded, without repeats", () => {
    expect(
      ids(appendOlderPage([artifact("a1"), artifact("a2")], [artifact("a2"), artifact("a3")])),
    ).toEqual(["a1", "a2", "a3"]);
  });
});
