import { describe, expect, test } from "bun:test";
import { botFileName, importNotes, readBotFile } from "./bot-file";
import { makeBot } from "./bot-fixture";

describe("bot file", () => {
  test("names the file after the bot, in characters every file system takes", () => {
    expect(botFileName("Ledger")).toBe("ledger.bot.json");
    expect(botFileName("Night Triage-2")).toBe("night-triage-2.bot.json");
    expect(botFileName("O'Brien's helper")).toBe("o-brien-s-helper.bot.json");
    expect(botFileName("数据 分析")).toBe("数据-分析.bot.json");
    expect(botFileName("...")).toBe("bot.bot.json");
  });

  test("reads what the import step shows from a bot file", () => {
    const read = readBotFile(
      JSON.stringify({
        format: "useagent.bot",
        version: 1,
        bot: {
          name: " Ledger ",
          title: "Data analyst",
          engine: "codex",
          avatarTone: "violet",
          avatarIcon: "code",
          repos: ["acme/app", 7],
        },
        routines: [{ name: "Weekly" }, { name: "Daily" }],
        note: "kept",
      }),
    );
    if ("error" in read) throw new Error(read.error);
    expect(read.draft).toEqual({
      document: {
        format: "useagent.bot",
        version: 1,
        bot: {
          name: " Ledger ",
          title: "Data analyst",
          engine: "codex",
          avatarTone: "violet",
          avatarIcon: "code",
          repos: ["acme/app", 7],
        },
        routines: [{ name: "Weekly" }, { name: "Daily" }],
        note: "kept",
      },
      name: "Ledger",
      title: "Data analyst",
      engine: "codex",
      avatarTone: "violet",
      avatarIcon: "code",
      repos: ["acme/app"],
      routines: 2,
    });
  });

  test("says a file that is not a bot file is not one", () => {
    const message = "This file is not a bot file. Choose a file made with Export bot.";
    for (const content of [
      "",
      "{",
      "[]",
      JSON.stringify({ format: "useagent.skill", bot: {} }),
      JSON.stringify({ format: "useagent.bot" }),
    ]) {
      expect(readBotFile(content)).toEqual({ error: message });
    }
  });

  test("names what an import left out, and nothing when it brought everything", () => {
    const bot = makeBot();
    expect(importNotes({ bot, routines: 1, skipped: { repos: [], model: null } })).toEqual([]);
    expect(
      importNotes({ bot, routines: 0, skipped: { repos: ["acme/docs"], model: null } }),
    ).toEqual([
      "This repository was left out because this workspace can't reach it: acme/docs. Add repositories in Bot details before the first message.",
    ]);
    expect(
      importNotes({
        bot,
        routines: 0,
        skipped: { repos: ["acme/docs", "acme/web"], model: "big-model" },
      }),
    ).toEqual([
      "These repositories were left out because this workspace can't reach them: acme/docs, acme/web. Add repositories in Bot details before the first message.",
      "The model big-model was left out because this workspace doesn't offer it. The bot uses the default model.",
    ]);
  });
});
