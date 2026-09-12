import { describe, expect, test } from "bun:test";
import { PersonalSandboxConnectionUnavailableError } from "../sandboxes/binding";
import { terminalFailureNotice, TERMINAL_UNAVAILABLE_NOTICE } from "./terminal";

describe("terminal failure notices", () => {
  test("revoked and missing personal connections stop reconnecting", () => {
    for (const message of [
      "the daytona connection that created this sandbox has been revoked",
      "the recorded personal connection was not found",
    ]) {
      const notice = terminalFailureNotice(new PersonalSandboxConnectionUnavailableError(message));
      expect(notice).toContain(TERMINAL_UNAVAILABLE_NOTICE);
      expect(notice).toContain(message);
      expect(notice).not.toContain("no live sandbox yet");
    }
  });

  test("keeps absent sandboxes retryable without hiding other failures", () => {
    expect(terminalFailureNotice(new Error("Sandbox abc not found"))).toContain("no live sandbox yet");
    const transient = terminalFailureNotice(new Error("connection timed out"));
    expect(transient).toContain("connection timed out");
    expect(transient).not.toContain(TERMINAL_UNAVAILABLE_NOTICE);
  });
});
