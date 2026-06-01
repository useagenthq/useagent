import { describe, expect, test } from "bun:test";
import { buildNativeCommandPrompt, revalidateCommandBeforeDispatch, validateCommandIntent } from "./command-intent";
import type { CanonicalCommand } from "@useagent/agent-harness/canonical";

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

describe("validateCommandIntent (FAIL-CLOSED against the live session catalog)", () => {
  const active = { sessionId: "s_cur", revision: 7 };
  const full = (over: Record<string, unknown>) => ({ name: "review", sessionId: "s_cur", catalogRevision: 7, ...over });

  test("a fully-identified command for the live session validates (name + session + revision)", () => {
    expect(validateCommandIntent(full({ args: "  x " }), catalog, active)).toEqual({ ok: true, name: "review", args: "  x " });
    expect(validateCommandIntent(full({ name: " status ", args: undefined }), catalog, active)).toEqual({ ok: true, name: "status", args: "" });
  });

  test("NO active session -> rejected (a pre-session priming cache never authorizes execution)", () => {
    expect(validateCommandIntent(full({ sessionId: undefined, catalogRevision: undefined }), catalog, { sessionId: null, revision: null }))
      .toEqual({ ok: false, reason: "no active session" });
  });

  test("an UNKNOWN command is rejected (never silently executed)", () => {
    expect(validateCommandIntent(full({ name: "notacommand" }), catalog, active)).toEqual({ ok: false, reason: "unknown command" });
  });

  test("an empty or malformed name is rejected", () => {
    expect(validateCommandIntent(full({ name: "" }), catalog, active).ok).toBe(false);
    expect(validateCommandIntent(full({ name: "has space" }), catalog, active)).toEqual({ ok: false, reason: "malformed command name" });
    expect(validateCommandIntent(full({ name: "etc/passwd" }), catalog, active)).toEqual({ ok: false, reason: "malformed command name" });
  });

  test("a MISSING or WRONG session id is rejected (client must prove the session)", () => {
    expect(validateCommandIntent(full({ sessionId: undefined }), catalog, active)).toEqual({ ok: false, reason: "missing session id" });
    expect(validateCommandIntent(full({ sessionId: "s_old" }), catalog, active)).toEqual({ ok: false, reason: "stale session" });
  });

  test("a MISSING or STALE catalog revision is rejected when the session carries one", () => {
    expect(validateCommandIntent(full({ catalogRevision: undefined }), catalog, active)).toEqual({ ok: false, reason: "missing catalog revision" });
    expect(validateCommandIntent(full({ catalogRevision: 6 }), catalog, active)).toEqual({ ok: false, reason: "stale catalog revision" });
    expect(validateCommandIntent(full({ catalogRevision: 7 }), catalog, active).ok).toBe(true);
  });

  test("an empty catalog rejects everything (a session that advertises no commands)", () => {
    expect(validateCommandIntent(full({}), [], active)).toEqual({ ok: false, reason: "unknown command" });
  });
});

describe("revalidateCommandBeforeDispatch (D4: re-check against the LIVE session immediately before send)", () => {
  const cmd = { name: "compact", provider: "claude", sessionId: "s1", catalogRevision: 5 };
  const live = { engine: "claude", sessionId: "s1", catalog: [{ name: "compact" }, { name: "review" }] };

  test("a fully identified command still present in the current provider catalog is safe", () => {
    expect(revalidateCommandBeforeDispatch(cmd, live)).toBeNull();
  });
  test("missing accepted identity fails closed", () => {
    expect(revalidateCommandBeforeDispatch({ ...cmd, provider: null }, live)).toContain("missing provider");
    expect(revalidateCommandBeforeDispatch({ ...cmd, sessionId: null }, live)).toContain("missing session");
    expect(revalidateCommandBeforeDispatch({ ...cmd, catalogRevision: null }, live)).toContain("missing catalog revision");
  });
  test("provider changed since acceptance -> rejected", () => {
    expect(revalidateCommandBeforeDispatch({ ...cmd, provider: "codex" }, live)).toContain("provider");
  });
  test("session was replaced (relay regen / session/load fail / new id) -> rejected", () => {
    expect(revalidateCommandBeforeDispatch(cmd, { ...live, sessionId: "s2" })).toContain("session");
  });
  test("the live session no longer advertises the command (membership) -> rejected", () => {
    expect(revalidateCommandBeforeDispatch(cmd, { ...live, catalog: [{ name: "review" }] })).toContain("not in the live session catalog");
    expect(revalidateCommandBeforeDispatch(cmd, { ...live, catalog: null })).toContain("not in the live session catalog");
    expect(revalidateCommandBeforeDispatch(cmd, { ...live, catalog: [] })).toContain("not in the live session catalog");
  });
});
