import { describe, expect, test } from "bun:test";
import { makeBot } from "./bot-fixture";
import { fetchLiveBot } from "./bot-thread-pane";

describe("live bot header state", () => {
  test("follows the backend's whole-bot state across idle, work, settlement, and approval", async () => {
    const states = ["idle", "working", "idle", "attention"] as const;
    const seen: string[] = [];
    const request = async (path: string) => {
      seen.push(path);
      const state = states.shift();
      return Response.json({
        bot: makeBot({
          id: "bot-nova",
          state,
          pendingApprovals: state === "attention" ? 1 : 0,
          handoffs: state === "working" ? 1 : 0,
        }),
      });
    };

    const projected = [];
    for (let index = 0; index < 4; index += 1) {
      projected.push((await fetchLiveBot("bot-nova", request))?.state);
    }
    expect(projected).toEqual(["idle", "working", "idle", "attention"]);
    expect(seen).toEqual(Array.from({ length: 4 }, () => "/api/bots/bot-nova"));
  });

  test("ignores a response for a different bot", async () => {
    expect(
      await fetchLiveBot("bot-nova", async () => Response.json({ bot: makeBot({ id: "bot-atlas" }) })),
    ).toBeNull();
  });
});
