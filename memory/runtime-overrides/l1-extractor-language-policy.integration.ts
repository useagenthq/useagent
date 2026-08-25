import assert from "node:assert/strict";
import test from "node:test";

test("current Latin user turn is enforced despite Chinese background", async () => {
  const { extractL1Memories } = await import("/app/src/core/record/l1-extractor.ts");
  const { LanguagePolicyError } = await import("/app/src/core/prompts/language-policy.ts");
  const response = JSON.stringify([{
    scene_name: "项目规划",
    message_ids: ["current-user"],
    memories: [{
      content: "用户需要尽快制作演示视频",
      type: "episodic",
      priority: 50,
      source_message_ids: ["current-user"],
      metadata: {},
    }],
  }]);
  let calls = 0;

  const extraction = extractL1Memories({
    messages: [
      { id: "background-user", role: "user", content: "之前的用户对话完全使用中文。", timestamp: 1 },
      { id: "current-assistant", role: "assistant", content: "我会继续使用中文回答。", timestamp: 2 },
      { id: "current-user", role: "user", content: "I need to prepare the complete demo video for the team review today.", timestamp: 3 },
    ],
    sessionKey: "language-policy-test",
    baseDir: "/tmp/l1-language-policy-test",
    config: {},
    options: {
      enableDedup: false,
      maxMessagesPerExtraction: 2,
      llmRunner: { run: async () => { calls += 1; return response; } },
    },
  });

  await assert.rejects(extraction, (error) => error instanceof LanguagePolicyError);
  assert.equal(calls, 2);
});
