import { describe, expect, test } from "bun:test";
import { buildNativeCommandPrompt, validateCommandIntent } from "./command-intent";
import type { CanonicalCommand } from "@skynet/agent-harness/canonical";

const catalog: CanonicalCommand[] = [{ name: "review" }, { name: "status" }, { name: "compact" }];

describe("buildNativeCommandPrompt (backend builds the provider prompt ONCE, byte-verbatim)", () => {
  test("no args -> just /name", () => {
    expect(buildNativeCommandPrompt("status")).toBe("/status");
    expect(buildNativeCommandPrompt("status", "")).toBe("/status");
    expect(buildNativeCommandPrompt("status", null)).toBe("/status");
  });
  test("args are preserved EXACTLY - whitespace, unicode, multiline (never trimmed)", () => {
    expect(buildNativeCommandPrompt("review", "src/app.ts")).toBe("/review src/app.ts");
    expect(buildNativeCommandPrompt("review", "  padded  ")).toBe("/review   padded  ");
    expect(buildNativeCommandPrompt("review", "café ☕ 你好")).toBe("/review café ☕ 你好");
    expect(buildNativeCommandPrompt("review", "line1\nline2\n")).toBe("/review line1\nline2\n");
  });
});

describe("validateCommandIntent (against the active authoritative catalog)", () => {
  test("a known command validates and returns the trimmed name + verbatim args", () => {
    expect(validateCommandIntent({ name: "review", args: "  x " }, catalog)).toEqual({ ok: true, name: "review", args: "  x " });
    expect(validateCommandIntent({ name: " status " }, catalog)).toEqual({ ok: true, name: "status", args: "" });
  });

  test("an UNKNOWN command is rejected (never silently executed)", () => {
    expect(validateCommandIntent({ name: "notacommand" }, catalog)).toEqual({ ok: false, reason: "unknown command" });
  });

  test("an empty or malformed name is rejected", () => {
    expect(validateCommandIntent({ name: "" }, catalog).ok).toBe(false);
    expect(validateCommandIntent({ name: "has space" }, catalog)).toEqual({ ok: false, reason: "malformed command name" });
    expect(validateCommandIntent({ name: "etc/passwd" }, catalog)).toEqual({ ok: false, reason: "malformed command name" });
  });

  test("a WRONG session is rejected (stale cross-session intent)", () => {
    expect(validateCommandIntent({ name: "review", sessionId: "s_old" }, catalog, { sessionId: "s_cur" })).toEqual({ ok: false, reason: "stale session" });
    expect(validateCommandIntent({ name: "review", sessionId: "s_cur" }, catalog, { sessionId: "s_cur" }).ok).toBe(true);
  });

  test("a STALE catalog revision is rejected", () => {
    expect(validateCommandIntent({ name: "review", catalogRevision: 1 }, catalog, { revision: 2 })).toEqual({ ok: false, reason: "stale catalog revision" });
    expect(validateCommandIntent({ name: "review", catalogRevision: 2 }, catalog, { revision: 2 }).ok).toBe(true);
  });

  test("an empty catalog rejects everything (a session that advertises no commands)", () => {
    expect(validateCommandIntent({ name: "review" }, []).ok).toBe(false);
  });
});
