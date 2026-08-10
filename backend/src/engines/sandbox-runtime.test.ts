import { afterEach, describe, expect, test } from "bun:test";
import type { Sandbox } from "@daytona/sdk";
import {
  forgetLiveThreadSandbox,
  getLiveThreadSandbox,
  rememberLiveThreadSandbox,
} from "./sandbox-runtime";

function sandbox(id: string): Sandbox {
  return { id } as Sandbox;
}

describe("live thread sandbox registry", () => {
  const threadId = "thread-runtime-cache";

  afterEach(() => forgetLiveThreadSandbox(threadId));

  test("retains the live SDK object, not just its durable id", () => {
    const box = sandbox("sandbox-1");

    rememberLiveThreadSandbox(threadId, box);

    expect(getLiveThreadSandbox(threadId)).toBe(box);
  });

  test("a rotated sandbox replaces the prior process-local object", () => {
    const replacement = sandbox("sandbox-2");
    rememberLiveThreadSandbox(threadId, sandbox("sandbox-1"));

    rememberLiveThreadSandbox(threadId, replacement);

    expect(getLiveThreadSandbox(threadId)).toBe(replacement);
  });

  test("old cleanup cannot evict a newer sandbox for the same thread", () => {
    const replacement = sandbox("sandbox-2");
    rememberLiveThreadSandbox(threadId, replacement);

    forgetLiveThreadSandbox(threadId, "sandbox-1");

    expect(getLiveThreadSandbox(threadId)).toBe(replacement);
  });
});
