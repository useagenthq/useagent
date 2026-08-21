import { describe, expect, test } from "bun:test";
import { createSecretRedactor } from "../secrets/redact";
import { emitOpenCodeFinalReply } from "./opencode-server";

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
