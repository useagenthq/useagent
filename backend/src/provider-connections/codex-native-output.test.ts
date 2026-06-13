import { describe, expect, test } from "bun:test";
import { prepareCodexServerFrame } from "./codex-native-output";

function imageFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    method: "item/completed",
    topLevelSecret: "/host/top-secret",
    params: {
      threadId: "provider-thread-1",
      turnId: "turn-1",
      paramsSecret: "/host/params-secret",
      item: {
        type: "imageGeneration",
        id: "image-item-1",
        status: "completed",
        savedPath: "/host/codex/generated_images/image.png",
        result: '{"savedPath":"/host/private/second.png"}',
        providerPrivateField: "token=secret&path=/host/private/third.png",
        nestedPrivateField: { path: "/host/nested-secret" },
        revisedPrompt: "draw a safe image",
        ...overrides,
      },
    },
  });
}

describe("prepareCodexServerFrame", () => {
  test("extracts a completed image locator and strips every opaque path field", () => {
    const prepared = prepareCodexServerFrame(imageFrame());
    expect(prepared.image).toEqual({
      sourceKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      threadId: "provider-thread-1",
      turnId: "turn-1",
      itemId: "image-item-1",
      savedPath: "/host/codex/generated_images/image.png",
    });
    expect(prepared.frame).not.toContain("/host/");
    expect(prepared.frame).not.toContain("savedPath");
    expect(prepared.frame).not.toContain("result");
    expect(prepared.frame).not.toContain("providerPrivateField");
    expect(prepared.frame).not.toContain("token=secret");
    expect(JSON.parse(prepared.frame)).toEqual({
      method: "item/completed",
      params: {
        threadId: "provider-thread-1",
        turnId: "turn-1",
        item: {
          type: "imageGeneration",
          id: "image-item-1",
          status: "completed",
          revisedPrompt: "draw a safe image",
        },
      },
    });
  });

  test("sanitizes non-terminal and failed image events without importing them", () => {
    const started = prepareCodexServerFrame(
      imageFrame({ status: "inProgress", result: "file:///host/private.png" })
        .replace("item/completed", "item/started"),
    );
    const failed = prepareCodexServerFrame(imageFrame({ status: "failed" }));

    expect(started.image).toBeNull();
    expect(failed.image).toBeNull();
    expect(started.frame).not.toContain("file:");
    expect(failed.frame).not.toContain("/host/");
  });

  test("allows only supported image methods and statuses", () => {
    const hostileMethod = JSON.parse(imageFrame());
    hostileMethod.method = "/host/private/method";
    const hostileStatus = JSON.parse(imageFrame());
    hostileStatus.params.item.status = "/host/private/status";

    const sanitizedMethod = prepareCodexServerFrame(JSON.stringify(hostileMethod));
    const sanitizedStatus = prepareCodexServerFrame(JSON.stringify(hostileStatus));

    expect(sanitizedMethod.image).toBeNull();
    expect(sanitizedStatus.image).toBeNull();
    expect(JSON.parse(sanitizedMethod.frame)).not.toHaveProperty("method");
    expect(JSON.parse(sanitizedStatus.frame).params.item).not.toHaveProperty("status");
    expect(sanitizedMethod.frame).not.toContain("/host/private/method");
    expect(sanitizedStatus.frame).not.toContain("/host/private/status");
  });

  test("does not infer a locator without a stable item id", () => {
    const prepared = prepareCodexServerFrame(imageFrame({ id: "" }));
    expect(prepared.image).toBeNull();
    expect(prepared.frame).not.toContain("/host/");
  });

  test("requires and hashes the full stable provider identity", () => {
    const original = prepareCodexServerFrame(imageFrame()).image;
    const otherThread = prepareCodexServerFrame(
      imageFrame().replace("provider-thread-1", "provider-thread-2"),
    ).image;
    const otherTurn = prepareCodexServerFrame(
      imageFrame().replace("turn-1", "turn-2"),
    ).image;

    expect(original).not.toBeNull();
    expect(otherThread?.sourceKey).not.toBe(original?.sourceKey);
    expect(otherTurn?.sourceKey).not.toBe(original?.sourceKey);

    const missingTurn = JSON.parse(imageFrame());
    delete missingTurn.params.turnId;
    expect(prepareCodexServerFrame(JSON.stringify(missingTurn)).image).toBeNull();

    const oversizedIdentity = JSON.parse(imageFrame());
    oversizedIdentity.params.threadId = "t".repeat(1_025);
    expect(prepareCodexServerFrame(JSON.stringify(oversizedIdentity)).image).toBeNull();
  });

  test("preserves unrelated and malformed frames byte-for-byte", () => {
    const unrelated = JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn-1" } } });
    expect(prepareCodexServerFrame(unrelated)).toEqual({ frame: unrelated, image: null });
    expect(prepareCodexServerFrame("not-json")).toEqual({ frame: "not-json", image: null });
  });
});
