import { describe, expect, test } from "bun:test";
import { escapeBelongsToNestedOverlay } from "./overlay-portal-container";

/** The slice of the DOM the helper reads: a role and a parent chain. */
interface Node {
  role: string | null;
  parent: Node | null;
  closest: (selector: string) => Node | null;
}

function node(role: string | null, parent: Node | null = null): Node {
  const self: Node = {
    role,
    parent,
    closest(selector) {
      const roles = [...selector.matchAll(/\[role="([a-z]+)"\]/g)].map((m) => m[1]);
      for (let cur: Node | null = self; cur; cur = cur.parent) {
        if (cur.role && roles.includes(cur.role)) return cur;
      }
      return null;
    },
  };
  return self;
}

// A modal's content, with a select listbox and a dropdown panel open inside it.
const content = node("dialog");
const container = content as unknown as HTMLElement;
const nameField = node(null, content);
const listbox = node("listbox", content);
const option = node("option", listbox);
const menu = node("dialog", content);
const menuItem = node(null, menu);
const outside = node(null);

describe("escape inside a nested overlay", () => {
  test("belongs to an open select listbox or dropdown panel", () => {
    expect(escapeBelongsToNestedOverlay(option as unknown as EventTarget, container)).toBe(true);
    expect(escapeBelongsToNestedOverlay(listbox as unknown as EventTarget, container)).toBe(true);
    expect(escapeBelongsToNestedOverlay(menuItem as unknown as EventTarget, container)).toBe(true);
  });

  test("belongs to the surface itself everywhere else", () => {
    expect(escapeBelongsToNestedOverlay(nameField as unknown as EventTarget, container)).toBe(false);
    expect(escapeBelongsToNestedOverlay(content as unknown as EventTarget, container)).toBe(false);
    expect(escapeBelongsToNestedOverlay(outside as unknown as EventTarget, container)).toBe(false);
    expect(escapeBelongsToNestedOverlay(null, container)).toBe(false);
  });
});
