import { expect, test } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import ErrorPage from "./error";

function findOnClick(node: ReactNode): (() => void) | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findOnClick(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<{ onClick?: () => void; children?: ReactNode }>(node)) return null;
  if (typeof node.props.onClick === "function") return node.props.onClick;
  return findOnClick(node.props.children);
}

test("Retry asks the server again instead of only re-rendering the failed segment", () => {
  const calls: string[] = [];
  const page = ErrorPage({
    error: new Error("thread load failed: 503"),
    reset: () => calls.push("reset"),
    retry: () => calls.push("retry"),
  });
  const onClick = findOnClick(page);
  expect(onClick).not.toBeNull();
  onClick?.();
  expect(calls).toEqual(["retry"]);
});
