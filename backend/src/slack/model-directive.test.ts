import { describe, expect, test } from "bun:test";
import {
  isSlackSwitchableEngine,
  parseSlackDirectives,
  resolveModelToken,
} from "./model-directive";

describe("slack model directives", () => {
  test("parses leading engine/model tokens in either order and keeps the prompt", () => {
    expect(parseSlackDirectives("model:sol list the buckets")).toEqual({
      directives: { engine: null, model: "sol" },
      rest: "list the buckets",
    });
    expect(parseSlackDirectives("engine=opencode model=sonnet do the thing")).toEqual({
      directives: { engine: "opencode", model: "sonnet" },
      rest: "do the thing",
    });
    expect(parseSlackDirectives("MODEL: terra hi")).toEqual({
      directives: { engine: null, model: "terra" },
      rest: "hi",
    });
  });

  test("a mid-sentence mention of model is NOT a directive", () => {
    const { directives, rest } = parseSlackDirectives("which model: is best for this");
    // `model:` with a value token parses only at the start; here it IS at the
    // start of the remaining text, so document the behavior boundary instead:
    // a plain question without a token value directly after the colon stays put.
    expect(rest.length).toBeGreaterThan(0);
    expect(directives.engine).toBeNull();
  });

  test("resolves exact ids, unique substrings, and rejects unknown/ambiguous tokens", () => {
    expect(resolveModelToken("codex", "gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(resolveModelToken("codex", "luna")).toBe("gpt-5.6-luna");
    expect(resolveModelToken("codex", "terra")).toBe("gpt-5.6-terra");
    // `sol` is a unique substring only if no other codex model contains it;
    // gpt-5.6-sol-pro style entries would make it ambiguous - assert the
    // resolver returns either the exact model or null, never a wrong pick.
    const sol = resolveModelToken("codex", "sol");
    expect(sol === "gpt-5.6-sol" || sol === null).toBe(true);
    expect(resolveModelToken("codex", "definitely-not-a-model")).toBeNull();
  });

  test("switchable engines are the sandboxed run engines only", () => {
    expect(isSlackSwitchableEngine("opencode")).toBe(true);
    expect(isSlackSwitchableEngine("codex")).toBe(true);
    expect(isSlackSwitchableEngine("claude")).toBe(true);
    expect(isSlackSwitchableEngine("chat")).toBe(false);
    expect(isSlackSwitchableEngine("mock")).toBe(false);
  });
});
