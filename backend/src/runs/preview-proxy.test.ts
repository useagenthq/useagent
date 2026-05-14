import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  forgetLiveThreadSandbox,
  rememberLiveThreadSandbox,
} from "../engines/sandbox-runtime";
import { resolvePreviewSandbox } from "./preview-proxy";

describe("preview sandbox resolution", () => {
  const threadId = "thread-preview-cache";

  afterEach(() => forgetLiveThreadSandbox(threadId));

  test("reuses the engine-owned SDK object without a Daytona lookup", async () => {
    const sandbox = { id: "sandbox-live", state: "started" } as SandboxHandle;
    rememberLiveThreadSandbox(threadId, sandbox);

    expect(await resolvePreviewSandbox(threadId)).toBe(sandbox);
  });

  test("wakes a cached retained sandbox in place", async () => {
    const start = mock(async () => {});
    const sandbox = {
      id: "sandbox-sleeping",
      state: "stopped",
      start,
    } as unknown as SandboxHandle;
    rememberLiveThreadSandbox(threadId, sandbox);

    expect(await resolvePreviewSandbox(threadId)).toBe(sandbox);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
