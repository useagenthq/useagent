import { describe, expect, test } from "bun:test";
import { BOT_FILE_ROUTINES_MAX, parseBotFile } from "./transfer";

function file(overrides: Record<string, unknown> = {}, bot: Record<string, unknown> = {}) {
  return {
    format: "useagent.bot",
    version: 1,
    bot: { name: "Ledger", title: "Data analyst", rules: "Numbers come from the warehouse.", engine: "mock", ...bot },
    routines: [{ name: "Weekly metrics", cron: "0 7 * * 1", timezone: "Europe/Berlin", prompt: "Build the weekly workbook." }],
    ...overrides,
  };
}

describe("bot file parsing", () => {
  test("reads the bot and its routines, filling the defaults a new bot gets", () => {
    const parsed = parseBotFile(file());
    expect(parsed).toEqual({
      file: {
        input: {
          name: "Ledger",
          title: "Data analyst",
          rules: "Numbers come from the warehouse.",
          engine: "mock",
          model: null,
          skillIds: [],
          repos: [],
          memoryScope: "org",
          avatarTone: "blue",
          avatarIcon: "robot",
        },
        routines: [{ name: "Weekly metrics", cron: "0 7 * * 1", timezone: "Europe/Berlin", prompt: "Build the weekly workbook." }],
      },
    });
  });

  test("ignores fields it does not know, ids and a pinned skill included", () => {
    const parsed = parseBotFile({
      ...file({ exportedBy: "someone@example.com", homeThreadId: "run-1" }, { id: "bot-1", skillIds: ["skill-1"], createdBy: "user-1", mood: "sunny" }),
      routines: [{ id: "schedule-1", name: "Daily", cron: "0 9 * * *", prompt: "Check the queue.", enabled: true, lastFiredAt: "2026-01-01T00:00:00Z" }],
    });
    if ("error" in parsed) throw new Error(parsed.error.reason);
    expect(parsed.file.input.skillIds).toEqual([]);
    expect(Object.keys(parsed.file.input).sort()).toEqual(
      ["avatarIcon", "avatarTone", "engine", "memoryScope", "model", "name", "repos", "rules", "skillIds", "title"],
    );
    // A routine without a zone runs in UTC, as an automation created without one does.
    expect(parsed.file.routines).toEqual([{ name: "Daily", cron: "0 9 * * *", timezone: "UTC", prompt: "Check the queue." }]);
  });

  test("a file with no routines imports the bot alone", () => {
    const { routines: _routines, ...withoutRoutines } = file();
    expect(parseBotFile(withoutRoutines)).toHaveProperty("file.routines", []);
  });

  test("names what is wrong with a file that is not a bot file", () => {
    expect(parseBotFile(null)).toHaveProperty("error.field", "file");
    expect(parseBotFile([file()])).toHaveProperty("error.field", "file");
    expect(parseBotFile(file({ format: "useagent.skill" }))).toHaveProperty("error.reason", "The file is not a bot file.");
    expect(parseBotFile(file({ version: 2 }))).toHaveProperty("error.reason", "The file was exported by a newer version of UseAgent.");
    expect(parseBotFile(file({ version: "1" }))).toHaveProperty("error.field", "version");
    expect(parseBotFile(file({ bot: "Ledger" }))).toHaveProperty("error.field", "bot");
    expect(parseBotFile(file({}, { name: "" }))).toHaveProperty("error.field", "name");
    expect(parseBotFile(file({}, { engine: "typewriter" }))).toHaveProperty("error.field", "engine");
    expect(parseBotFile(file({}, { avatarTone: "plaid" }))).toHaveProperty("error.field", "avatarTone");
    expect(parseBotFile(file({ routines: "daily" }))).toHaveProperty("error.field", "routines");
  });

  test("checks every routine before anything is created", () => {
    const routine = { name: "Daily", cron: "0 9 * * *", prompt: "Check the queue." };
    const second = (patch: Record<string, unknown>) => parseBotFile(file({ routines: [routine, { ...routine, ...patch }] }));
    expect(second({ name: " " })).toEqual({ error: { field: "routines[1].name", reason: "every routine needs a name" } });
    expect(second({ cron: "every day" })).toEqual({ error: { field: "routines[1].cron", reason: "Daily needs a valid 5-field cron schedule" } });
    expect(second({ timezone: "Mars/Olympus" })).toEqual({ error: { field: "routines[1].timezone", reason: "Daily names an unknown time zone" } });
    expect(second({ prompt: "" })).toEqual({ error: { field: "routines[1].prompt", reason: "Daily needs a prompt" } });
    expect(second({ prompt: "x".repeat(64_001) })).toEqual({ error: { field: "routines[1].prompt", reason: "Daily has a prompt that is too long" } });
    expect(parseBotFile(file({ routines: ["Daily"] }))).toHaveProperty("error.field", "routines[0]");
    expect(parseBotFile(file({ routines: Array.from({ length: BOT_FILE_ROUTINES_MAX + 1 }, () => routine) })))
      .toHaveProperty("error.reason", "A bot file brings at most 20 routines.");
  });
});
