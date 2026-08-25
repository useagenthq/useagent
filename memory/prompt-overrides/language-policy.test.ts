import { describe, expect, test } from "bun:test";

import {
  buildLatinRetryInstruction,
  classifySourceScript,
  extractWithLanguagePolicy,
  LATIN_RETRY_INSTRUCTION,
  LanguagePolicyError,
  sourceHanSpans,
} from "./language-policy";

describe("L1 extraction language policy", () => {
  test("retries Latin-dominant source once and throws a typed error after a second Han result", async () => {
    const calls: Array<string | undefined> = [];
    const scenes = [{ scene_name: "项目规划", memories: [{ content: "用户需要演示视频" }] }];

    const extraction = extractWithLanguagePolicy({
      sourceMessages: [{ role: "user", content: "I need to make the demo video as soon as possible." }],
      extract: async (correctionInstruction) => {
        calls.push(correctionInstruction);
        return scenes;
      },
    });

    await expect(extraction).rejects.toBeInstanceOf(LanguagePolicyError);
    expect(calls).toEqual([undefined, LATIN_RETRY_INSTRUCTION]);
  });

  test("accepts a corrected Latin-script scene and memory after one retry", async () => {
    let callCount = 0;
    const result = await extractWithLanguagePolicy({
      sourceMessages: [{ role: "user", content: "The user prefers concise status updates." }],
      extract: async () => {
        callCount += 1;
        return callCount === 1
          ? [{ scene_name: "沟通偏好", memories: [{ content: "The user prefers concise updates." }] }]
          : [{ scene_name: "Communication preference", memories: [{ content: "The user prefers concise updates." }] }];
      },
    });

    expect(callCount).toBe(2);
    expect(result).toEqual([
      { scene_name: "Communication preference", memories: [{ content: "The user prefers concise updates." }] },
    ]);
  });

  test("preserves Chinese source and output without retry", async () => {
    let callCount = 0;
    const scenes = [{ scene_name: "演示安排", memories: [{ content: "用户希望尽快录制演示视频。" }] }];

    const result = await extractWithLanguagePolicy({
      sourceMessages: [{ role: "user", content: "我想尽快录制演示视频。" }],
      extract: async () => {
        callCount += 1;
        return scenes;
      },
    });

    expect(result).toEqual(scenes);
    expect(callCount).toBe(1);
  });

  test("uses user prose and ignores assistant text, URLs, code, and identifiers", async () => {
    const sourceMessages = [
      {
        role: "user",
        content: "Please summarize the deployment result and prepare the demo video. https://例子.测试/path `const 状态 = fooBar` build_release_id",
      },
      { role: "assistant", content: "我会把所有内容转换为中文并保存。" },
    ];
    let callCount = 0;

    const result = await extractWithLanguagePolicy({
      sourceMessages,
      extract: async () => {
        callCount += 1;
        return [{ scene_name: "Demo 项", memories: [{ content: "Prepare the demo video." }] }];
      },
    });

    expect(classifySourceScript(sourceMessages)).toBe("latin");
    expect(result).toHaveLength(1);
    expect(callCount).toBe(1);

    expect(classifySourceScript([
      { role: "user", content: "Please summarize the deployment result and prepare the demo video 项 for review." },
    ])).toBe("latin");
  });

  test("classifies Chinese-dominant and mixed source without forcing Latin output", () => {
    expect(classifySourceScript([
      { role: "user", content: "请尽快准备演示视频，完成后通知团队。 API" },
    ])).toBe("chinese");

    expect(classifySourceScript([
      { role: "user", content: "Please prepare the demo video and 同时准备中文版本交给团队审核。" },
    ])).toBe("mixed");
  });

  test.each([
    ["Spanish", "Necesito preparar el video de demostración para la revisión del equipo.", "Preparación", "Preparar el video de demostración."],
    ["French", "Je dois préparer la vidéo de démonstration pour la revue de l'équipe.", "Préparation", "Préparer la vidéo de démonstration."],
  ])("preserves the %s source language in the retry instruction", async (_language, source, correctedScene, correctedContent) => {
    const instructions: Array<string | undefined> = [];
    const result = await extractWithLanguagePolicy({
      sourceMessages: [{ role: "user", content: source }],
      extract: async (instruction) => {
        instructions.push(instruction);
        return instruction
          ? [{ scene_name: correctedScene, memories: [{ content: correctedContent }] }]
          : [{ scene_name: "演示准备", memories: [{ content: "准备演示视频。" }] }];
      },
    });

    expect(instructions).toEqual([undefined, LATIN_RETRY_INSTRUCTION]);
    expect(LATIN_RETRY_INSTRUCTION).toContain("preserve the exact source language");
    expect(LATIN_RETRY_INSTRUCTION).toContain("do not translate");
    expect(result[0]?.scene_name).toBe(correctedScene);
    expect(result[0]?.memories[0]?.content).toBe(correctedContent);
  });

  test("accepts an exact Han span copied from the current user source", async () => {
    const sourceMessages = [{
      role: "user",
      content: "Please record that the customer uses 中国银行 for the settlement account.",
    }];
    let calls = 0;
    const scenes = [{
      scene_name: "Settlement 中国银行 account",
      memories: [{ content: "The customer uses 中国银行 for settlement." }],
    }];

    const result = await extractWithLanguagePolicy({
      sourceMessages,
      extract: async () => { calls += 1; return scenes; },
    });

    expect(sourceHanSpans(sourceMessages)).toEqual(["中国银行"]);
    expect(result).toEqual(scenes);
    expect(calls).toBe(1);
  });

  test("retries novel Han prose while preserving an allowed source span verbatim", async () => {
    const sourceMessages = [{
      role: "user",
      content: "Please record that the customer uses 中国银行 for the settlement account.",
    }];
    const instructions: Array<string | undefined> = [];

    const result = await extractWithLanguagePolicy({
      sourceMessages,
      extract: async (instruction) => {
        instructions.push(instruction);
        return instruction
          ? [{ scene_name: "Settlement account", memories: [{ content: "The customer uses 中国银行 for settlement." }] }]
          : [{ scene_name: "Settlement account", memories: [{ content: "用户使用中国银行办理业务。" }] }];
      },
    });

    expect(instructions).toEqual([undefined, buildLatinRetryInstruction(["中国银行"])]);
    expect(instructions[1]).toContain("中国银行");
    expect(instructions[1]).toContain("verbatim without translating");
    expect(result[0]?.memories[0]?.content).toContain("中国银行");
  });

  test("rejects novel Han prose after retry even when it contains an allowed source span", async () => {
    const calls: Array<string | undefined> = [];
    const extraction = extractWithLanguagePolicy({
      sourceMessages: [{ role: "user", content: "Please use 中国银行 as the settlement account for this customer." }],
      extract: async (instruction) => {
        calls.push(instruction);
        return [{ scene_name: "Settlement", memories: [{ content: "用户使用中国银行办理业务。" }] }];
      },
    });

    await expect(extraction).rejects.toBeInstanceOf(LanguagePolicyError);
    expect(calls).toHaveLength(2);
  });

  test("keeps the no-Han retry instruction unchanged", () => {
    expect(buildLatinRetryInstruction([])).toBe(LATIN_RETRY_INSTRUCTION);
  });
});
