import { describe, expect, test } from "bun:test";
import { createSecretRedactor } from "../secrets/redact";
import {
  emitOpenCodeFinalReply,
  redactOpenCodeSessionLifecycleInfo,
} from "./opencode-server";

describe("OpenCode final reply credential boundary", () => {
  test("redacts the authoritative final reply before emitting or storing it", async () => {
    const secret = "SYNTHETIC_OPENCODE_FINAL_SECRET_123456";
    const emitted: unknown[] = [];
    let summary = "";

    await emitOpenCodeFinalReply(
      {
        emit: async (step) => {
          emitted.push(step);
          return undefined;
        },
        setSummary: (value) => {
          summary = value;
        },
      },
      [`Finished with ${secret}`],
      createSecretRedactor([secret]),
      25,
    );

    expect(JSON.stringify({ emitted, summary })).not.toContain(secret);
    expect(emitted).toContainEqual({
      kind: "task",
      label: "Finished with <redacted>",
      chip: "task",
    });
    expect(summary).toBe("Finished with <redacted>");
  });
});

describe("OpenCode child-session lifecycle redaction", () => {
  test("redacts session titles while preserving correlation identifiers", () => {
    const secret = "SYNTHETIC_SESSION_TITLE_SECRET_123456";
    const info = {
      id: "child-session-stable",
      parentID: "parent-session-stable",
      title: `Investigate ${secret}`,
    };

    expect(
      redactOpenCodeSessionLifecycleInfo(
        info,
        createSecretRedactor([secret, info.id, info.parentID]),
      ),
    ).toEqual({
      id: info.id,
      parentID: info.parentID,
      title: "Investigate <redacted>",
    });
  });
});
