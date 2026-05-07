// Unit tests for the sandbox memory-FILE shape: the round-trip contract (build a
// restore digest → extract the body an agent would edit → capture it back) plus
// the honesty header, scope labeling, meaningful-body gate, and byte budget. Pure
// — no DB, no sandbox.
import { describe, expect, test } from "bun:test";
import {
  MEMORY_BODY_MARKER,
  buildMemoryDigest,
  extractMemoryBody,
  hasMeaningfulBody,
} from "./memory-file";

const TS = "2026-08-06T12:00:00.000Z";

describe("buildMemoryDigest", () => {
  test("empty state: honest header + marker, no facts", () => {
    const out = buildMemoryDigest({ restoredAt: TS, bodies: [], recall: null });
    expect(out).toContain("# Team memory (restored)");
    expect(out).toContain(`Restored from team memory at ${TS}`);
    // The stale-promise fixes: continuity + distillation-latency note.
    expect(out).toContain("persist across sessions");
    expect(out).toContain("take a few minutes");
    expect(out).toContain(MEMORY_BODY_MARKER);
    expect(out).toContain("no distilled team memory surfaced");
  });

  test("restores a prior durable body BELOW the marker (round-trips)", () => {
    const out = buildMemoryDigest({
      restoredAt: TS,
      bodies: [{ scope: "personal", body: "- favourite color is teal-1234" }],
      recall: null,
    });
    // The fact lands in the durable region, so the next capture re-extracts it.
    expect(extractMemoryBody(out)).toBe("- favourite color is teal-1234");
  });

  test("distilled recall renders as reference ABOVE the marker (not captured)", () => {
    const out = buildMemoryDigest({
      restoredAt: TS,
      bodies: [{ scope: "personal", body: "- durable note" }],
      recall: {
        items: [
          { content: "the sky is blue", sourceScope: "org" },
          { content: "the user likes teal", sourceScope: "personal" },
        ],
      },
    });
    const marker = out.indexOf(MEMORY_BODY_MARKER);
    // recall lines are before the marker; scope-labeled because >1 scope present
    expect(out.slice(0, marker)).toContain("[org] the sky is blue");
    expect(out.slice(0, marker)).toContain("[personal] the user likes teal");
    // and they are NOT part of the captured body
    expect(extractMemoryBody(out)).toBe("- durable note");
  });

  test("single-scope recall is unlabeled", () => {
    const out = buildMemoryDigest({
      restoredAt: TS,
      bodies: [],
      recall: { items: [{ content: "one org fact", sourceScope: "org" }] },
    });
    expect(out).toContain("- one org fact");
    expect(out).not.toContain("[org]");
  });

  test("merges + dedupes multiple pool bodies, labeling each block", () => {
    const out = buildMemoryDigest({
      restoredAt: TS,
      bodies: [
        { scope: "personal", body: "- personal fact" },
        { scope: "org", body: "- org fact" },
        { scope: "org", body: "- personal fact" }, // dup of the personal body → dropped
      ],
      recall: null,
    });
    const body = extractMemoryBody(out);
    expect(body).toContain("- personal fact");
    expect(body).toContain("- org fact");
    expect(body).toContain("from personal memory");
    // the duplicate appears once
    expect(body.match(/- personal fact/g)?.length).toBe(1);
  });

  test("honors the byte budget, keeping the header + marker", () => {
    const huge = "x".repeat(50_000);
    const out = buildMemoryDigest({
      restoredAt: TS,
      bodies: [{ scope: "personal", body: huge }],
      recall: null,
      maxBytes: 2048,
    });
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(2048);
    expect(out).toContain("# Team memory (restored)");
    expect(out).toContain(MEMORY_BODY_MARKER);
  });
});

describe("extractMemoryBody", () => {
  test("returns text after the marker, trimmed", () => {
    const file = `header stuff\n${MEMORY_BODY_MARKER}\n\n- the note\n`;
    expect(extractMemoryBody(file)).toBe("- the note");
  });

  test("falls back to the whole file when the marker is absent", () => {
    expect(extractMemoryBody("agent rewrote the whole thing")).toBe(
      "agent rewrote the whole thing",
    );
  });
});

describe("hasMeaningfulBody", () => {
  test("blank / whitespace / comment-only bodies are not meaningful", () => {
    expect(hasMeaningfulBody("")).toBe(false);
    expect(hasMeaningfulBody("   \n\t ")).toBe(false);
    expect(hasMeaningfulBody("<!-- just a hint -->")).toBe(false);
  });

  test("a real note is meaningful", () => {
    expect(hasMeaningfulBody("- favourite color is teal-1234")).toBe(true);
  });
});
