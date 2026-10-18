import { describe, expect, test } from "bun:test";
import { detachedLaunchScript, killSessionScript, sessionDir, shellQuote } from "../src/sessions";

describe("session scripts", () => {
  test("shell quoting survives single quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  test("session directories live under one root", () => {
    expect(sessionDir("s-1")).toBe("/tmp/useagent/sessions/s-1");
  });

  test("session and command ids are single path segments", () => {
    for (const bad of ["../x", "a/b", "", ".."]) {
      expect(() => sessionDir(bad)).toThrow(/plain identifier/);
    }
    expect(sessionDir("useagent-t3.env_1")).toBe("/tmp/useagent/sessions/useagent-t3.env_1");
  });

  test("the kill script leaves alone a command that already recorded its exit", () => {
    expect(killSessionScript("/tmp/useagent/sessions/s")).toContain('[ -e "${f%.pid}.exit" ] && continue');
  });

  test("the kill script walks /proc by session id and never trusts a pid file blindly", () => {
    const script = killSessionScript("/tmp/useagent/sessions/s");
    expect(script).toContain("case \"$p\" in ''|*[!0-9]*) continue;; esac");
    expect(script).toContain('[ "$4" = "$p" ] && kill -TERM "$pid"');
    expect(script).toContain('kill -TERM "$p"');
  });

  test("the detached launcher records its pid, keeps stdin open and writes the exit code last", () => {
    const script = detachedLaunchScript("/tmp/useagent/sessions/s/c", "s", "c");
    const lines = script.split("\n");
    expect(lines[0]).toBe("#!/bin/sh");
    expect(script).toContain("exec 3<>'/tmp/useagent/sessions/s/c.in'");
    expect(script).toContain(`printf '%s\\n' "$$" > '/tmp/useagent/sessions/s/c.pid'`);
    expect(script).toContain("USEAGENT_SESSION_ID='s' USEAGENT_COMMAND_ID='c'");
    expect(script).toContain("sh '/tmp/useagent/sessions/s/c.sh' <&3 >'/tmp/useagent/sessions/s/c.log' 2>&1");
    expect(lines.indexOf("code=$?")).toBeGreaterThan(lines.findIndex((l) => l.includes("c.sh")));
    expect(script).toContain(`printf '%s\\n' "$code" > '/tmp/useagent/sessions/s/c.exit'`);
    expect(lines.at(-2)).toBe("exit 0");
  });
});
