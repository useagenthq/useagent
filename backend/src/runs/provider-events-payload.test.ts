import { expect, test } from "bun:test";
import { makeNativeFrame } from "./native-events";
import {
  CHILD_TRANSCRIPT_PAYLOAD_CAP_BYTES,
  PROVIDER_PAYLOAD_CAP_BYTES,
  providerPayloadCapBytes,
  serializeProviderPayload,
} from "./provider-events";
import { translateOpenCode } from "../engines/opencode-canonical";

test("preserves a 64k child transcript as valid durable JSON", () => {
  const text = "\u0000".repeat(64_000);
  const payload = {
    id: "child-message:thread:child:message",
    kind: "child.message.completed",
    payload: {
      agentId: "child",
      childSessionId: "child",
      parentAgentId: "root",
      messageId: "message",
      itemId: "message",
      streamKind: "assistant_text",
      text,
      status: "completed",
      revision: 2,
      timelineBypass: true,
    },
  };
  const cap = providerPayloadCapBytes({
    eventType: "t3.activity.child.message.completed",
    nativeSessionId: "child",
    nativeParentSessionId: "root",
    nativeMessageId: "message",
  });
  expect(cap).toBe(CHILD_TRANSCRIPT_PAYLOAD_CAP_BYTES);
  const serialized = serializeProviderPayload(payload, cap);
  expect(serialized).not.toBeNull();
  expect(new TextEncoder().encode(serialized!).byteLength).toBeLessThanOrEqual(
    CHILD_TRANSCRIPT_PAYLOAD_CAP_BYTES,
  );
  expect(JSON.parse(serialized!).payload.text).toHaveLength(64_000);

  const frame = makeNativeFrame({
    eventId: "child-message",
    seq: 1,
    provider: "t3",
    eventType: "t3.activity.child.message.completed",
    sessionId: "child",
    parentSessionId: "root",
    messageId: "message",
    partId: "child-message:thread:child:message",
    callId: null,
    payloadText: serialized,
  });
  const canonical = translateOpenCode([frame], {
    runId: "run",
    threadId: "thread",
  }).events;
  expect(canonical.find((event) => event.kind === "message.delta")).toMatchObject({
    kind: "message.delta",
    messageId: "message",
    text,
    identity: {
      nativeSessionId: "child",
      nativeParentSessionId: "root",
    },
  });
});

test("oversize provider payloads remain valid JSON markers", () => {
  const serialized = serializeProviderPayload({ text: "x".repeat(PROVIDER_PAYLOAD_CAP_BYTES) });
  expect(JSON.parse(serialized!)).toMatchObject({
    _truncated: true,
    _reason: "provider payload exceeded durable byte limit",
  });
});

test("ordinary and partially attributed events keep the 32k payload limit", () => {
  expect(providerPayloadCapBytes({
    eventType: "t3.activity.tool.completed",
    nativeSessionId: "root",
    nativeParentSessionId: null,
    nativeMessageId: null,
  })).toBe(PROVIDER_PAYLOAD_CAP_BYTES);
  expect(providerPayloadCapBytes({
    eventType: "t3.activity.child.message.completed",
    nativeSessionId: "child",
    nativeParentSessionId: null,
    nativeMessageId: "message",
  })).toBe(PROVIDER_PAYLOAD_CAP_BYTES);
});
