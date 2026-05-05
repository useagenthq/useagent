import { describe, expect, it } from "bun:test";
import { AllowList } from "./authorize";

describe("AllowList — deny-by-default", () => {
  it("authorizes nobody when unconfigured (empty allow-list)", () => {
    const allow = new AllowList();
    expect(allow.authorize("U1")).toBe(false);
    expect(allow.authorize("anyone")).toBe(false);
    expect(allow.size).toBe(0);
  });

  it("denies a blank / missing id even when the list is non-empty", () => {
    const allow = new AllowList(["U1"]);
    expect(allow.authorize("")).toBe(false);
    expect(allow.authorize("   ")).toBe(false);
  });

  it("authorizes only the exact allow-listed principals", () => {
    const allow = new AllowList(["U1", "U2"]);
    expect(allow.authorize("U1")).toBe(true);
    expect(allow.authorize("U2")).toBe(true);
    expect(allow.authorize("U3")).toBe(false);
  });

  it("is frozen at construction — mutating the source can't widen access", () => {
    const source = ["U1"];
    const allow = new AllowList(source);
    source.push("U2"); // too late — the set was copied
    expect(allow.authorize("U2")).toBe(false);
    expect(allow.authorize("U1")).toBe(true);
  });

  it("trims whitespace and drops blank entries from the list", () => {
    const allow = new AllowList([" U1 ", "", "   ", "U2"]);
    expect(allow.size).toBe(2);
    expect(allow.authorize("U1")).toBe(true); // matched trimmed
    expect(allow.authorize(" U2 ")).toBe(true); // input trimmed too
    expect(allow.values()).toEqual(["U1", "U2"]);
  });

  it("has() aliases authorize()", () => {
    const allow = new AllowList(["a@x.com"]);
    expect(allow.has("a@x.com")).toBe(true);
    expect(allow.has("b@x.com")).toBe(false);
  });
});
