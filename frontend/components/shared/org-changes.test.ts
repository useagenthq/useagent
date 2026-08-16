import { describe, expect, test } from "bun:test";
import { type OrgChange, parseOrgChange, subscribeOrgChanges } from "@/lib/org-changes";

class FakeEventSource extends EventTarget {
  static readonly instances: FakeEventSource[] = [];

  readonly url: string;
  closed = false;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  emitChange(change: OrgChange): void {
    this.dispatchEvent(new MessageEvent("change", { data: JSON.stringify(change) }));
  }
}

describe("org change protocol", () => {
  test("accepts IDs-only product invalidations", () => {
    expect(
      parseOrgChange({
        type: "run",
        action: "running",
        runId: "run-1",
        threadId: "thread-1",
      }),
    ).toEqual({ type: "run", action: "running", runId: "run-1", threadId: "thread-1" });

    expect(
      parseOrgChange({
        type: "artifact",
        action: "updated",
        artifactId: "artifact-1",
        runId: "run-1",
        threadId: "thread-1",
      }),
    ).toEqual({
      type: "artifact",
      action: "updated",
      artifactId: "artifact-1",
      runId: "run-1",
      threadId: "thread-1",
    });

    expect(
      parseOrgChange({
        type: "provider_connection",
        action: "revoked",
        provider: "openai",
        authMethod: "chatgpt_oauth",
      }),
    ).toEqual({
      type: "provider_connection",
      action: "revoked",
      provider: "openai",
      authMethod: "chatgpt_oauth",
    });

    expect(
      parseOrgChange({
        type: "automation",
        action: "fired",
        automationId: "automation-1",
        runId: "run-1",
      }),
    ).toEqual({
      type: "automation",
      action: "fired",
      automationId: "automation-1",
      runId: "run-1",
    });
  });

  test("rejects malformed or unknown invalidations", () => {
    expect(parseOrgChange(null)).toBeNull();
    expect(
      parseOrgChange({ type: "run", action: "deleted", runId: "r", threadId: "t" }),
    ).toBeNull();
    expect(
      parseOrgChange({ type: "artifact", action: "created", runId: "r", threadId: "t" }),
    ).toBeNull();
    expect(
      parseOrgChange({
        type: "provider_connection",
        action: "updated",
        provider: "stripe",
        authMethod: "api_key",
      }),
    ).toBeNull();
    expect(
      parseOrgChange({
        type: "provider_connection",
        action: "created",
        provider: "openai",
        authMethod: "api_key",
      }),
    ).toBeNull();
    expect(
      parseOrgChange({ type: "automation", action: "fired", automationId: "automation-1" }),
    ).toBeNull();
    expect(
      parseOrgChange({ type: "automation", action: "paused", automationId: "automation-1" }),
    ).toBeNull();
  });

  test("shares one stream, coalesces duplicate invalidations, and closes after the last subscriber", async () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const eventSourceDescriptor = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      value: FakeEventSource,
    });

    const first: OrgChange[] = [];
    const second: OrgChange[] = [];
    const unsubscribeFirst = subscribeOrgChanges((change) => first.push(change));
    const unsubscribeSecond = subscribeOrgChanges((change) => second.push(change));

    try {
      expect(FakeEventSource.instances).toHaveLength(1);
      const source = FakeEventSource.instances[0];
      if (!source) throw new Error("expected the shared EventSource to connect");
      const change = {
        type: "automation",
        action: "updated",
        automationId: "automation-live",
      } satisfies OrgChange;
      source.emitChange(change);
      source.emitChange(change);
      await Promise.resolve();

      expect(first).toEqual([change]);
      expect(second).toEqual([change]);
      unsubscribeFirst();
      expect(source.closed).toBeFalse();
      unsubscribeSecond();
      expect(source.closed).toBeTrue();
    } finally {
      unsubscribeFirst();
      unsubscribeSecond();
      FakeEventSource.instances.length = 0;
      if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
      else Reflect.deleteProperty(globalThis, "window");
      if (eventSourceDescriptor) {
        Object.defineProperty(globalThis, "EventSource", eventSourceDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "EventSource");
      }
    }
  });
});
