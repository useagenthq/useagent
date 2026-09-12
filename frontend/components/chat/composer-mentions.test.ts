import { describe, expect, test } from "bun:test";
import {
  botMention,
  botToken,
  detectMentionTrigger,
  fileMention,
  insertMentionToken,
  type Mention,
  mentionedBotIds,
  mentionKey,
  mentionsReducer,
  mentionsToRunResources,
  mentionsToRunResources as toRunResources,
  parseDraftMentions,
  prMention,
  removeMentionToken,
  shortThreadId,
  skillMention,
  threadMention,
  unlinkedBotTokens,
} from "./composer-mentions";
import { repoTreeUrl } from "./composer-mentions-ui";

describe("detectMentionTrigger - caret + word boundary", () => {
  test("opens at the start of the text", () => {
    expect(detectMentionTrigger("@", 1)).toEqual({ query: "", start: 0 });
    expect(detectMentionTrigger("@rea", 4)).toEqual({ query: "rea", start: 0 });
  });

  test("opens after whitespace (a real word boundary)", () => {
    expect(detectMentionTrigger("fix @re", 7)).toEqual({ query: "re", start: 4 });
    expect(detectMentionTrigger("a\n@x", 4)).toEqual({ query: "x", start: 2 });
  });

  test("does NOT open when @ is glued to a preceding word (email-like)", () => {
    expect(detectMentionTrigger("me@example", 10)).toBeNull();
  });

  test("closes once whitespace follows the @ (mention finished)", () => {
    expect(detectMentionTrigger("@skill/foo bar", 14)).toBeNull();
  });

  test("returns null with no @ before the caret", () => {
    expect(detectMentionTrigger("hello world", 11)).toBeNull();
  });

  test("uses the caret, not the full text, to bound the query", () => {
    // caret sits right after "re"; the trailing "adme" is ignored.
    expect(detectMentionTrigger("@readme", 3)).toEqual({ query: "re", start: 0 });
  });
});

describe("insertMentionToken - splices the token and moves the caret", () => {
  test("replaces the @query span with `token ` and lands the caret after it", () => {
    const token = "@skill/humanizer";
    const res = insertMentionToken("fix @hum", 4, 8, token);
    expect(res.text).toBe("fix @skill/humanizer ");
    expect(res.caret).toBe(4 + token.length + 1);
    // caret is positioned right after the trailing space
    expect(res.text.slice(res.caret)).toBe("");
  });

  test("preserves text on both sides of the span", () => {
    const res = insertMentionToken("a @x b", 2, 4, "@thread/1234abcd");
    expect(res.text).toBe("a @thread/1234abcd  b");
  });
});

describe("removeMentionToken - best-effort text sync", () => {
  test("removes the first occurrence and eats its trailing space", () => {
    expect(removeMentionToken("fix @skill/foo now", "@skill/foo")).toBe("fix now");
  });

  test("is a no-op when the token was already edited away", () => {
    expect(removeMentionToken("fix it", "@skill/foo")).toBe("fix it");
  });

  test("only removes the first occurrence", () => {
    expect(removeMentionToken("@a/b:x @a/b:x", "@a/b:x")).toBe("@a/b:x");
  });
});

describe("mentionsToRunResources", () => {
  const mentions: Mention[] = [
    prMention("useagenthq/skynet", 123, "Fix the composer"),
    fileMention("useagenthq/skynet", "src/index.ts", "feature/mentions"),
    threadMention("abcd1234efgh", "Ship mentions"),
    skillMention("skill-1", "humanizer"),
  ];

  test("emits only typed identities and keeps server-owned fields off the wire", () => {
    expect(mentionsToRunResources(mentions)).toEqual([
      {
        kind: "code.change",
        provider: "github",
        locator: {
          type: "github.pull_request",
          repository: "useagenthq/skynet",
          number: 123,
          revision: null,
        },
      },
      {
        kind: "code.repository",
        provider: "github",
        locator: {
          type: "github.repository",
          repository: "useagenthq/skynet",
          revision: "feature/mentions",
        },
      },
      {
        kind: "thread",
        provider: "useagent",
        locator: { type: "thread", id: "abcd1234efgh" },
      },
    ]);
  });
});

test("file browse sends the selected branch and directory", () => {
  expect(repoTreeUrl("useagenthq/skynet", "feature/mentions", "src/app")).toBe(
    "/api/repos/useagenthq/skynet/tree?ref=feature%2Fmentions&path=src%2Fapp",
  );
});

describe("mentionsReducer", () => {
  test("adds a mention", () => {
    const state = mentionsReducer([], { type: "add", mention: skillMention("s1", "a") });
    expect(state).toHaveLength(1);
  });

  test("dedupes by identity (same skill id) - not by display token", () => {
    const first = mentionsReducer([], { type: "add", mention: skillMention("s1", "a") });
    const second = mentionsReducer(first, { type: "add", mention: skillMention("s1", "a") });
    expect(second).toHaveLength(1);
    expect(second).toBe(first); // unchanged reference when nothing was added
  });

  test("removes by key and clears", () => {
    const m = fileMention("a/b", "x.ts", null);
    const added = mentionsReducer([], { type: "add", mention: m });
    const removed = mentionsReducer(added, { type: "remove", key: mentionKey(m) });
    expect(removed).toEqual([]);
    const refilled = mentionsReducer(added, { type: "clear" });
    expect(refilled).toEqual([]);
  });
});

describe("identity + short id helpers", () => {
  test("shortThreadId takes the leading run-id segment", () => {
    expect(shortThreadId("abcd1234-5678-90ab")).toBe("abcd1234");
  });

  test("mentionKey is stable per identity across kinds", () => {
    expect(mentionKey(skillMention("s1", "a"))).toBe("skill:s1");
    expect(mentionKey(prMention("o/r", 9, "t"))).toBe("pr:o/r#9");
    expect(mentionKey(fileMention("o/r", "a/b.ts", null))).toBe("file:o/r:a/b.ts");
    expect(mentionKey(threadMention("abcd1234ef", "t"))).toBe("thread:abcd1234ef");
  });
});

describe("bot mentions", () => {
  test("a bot chip is a handoff, not a resource: token names it, the id rides separately", () => {
    const nova = botMention(
      "11111111-1111-4111-8111-111111111111",
      "Nova",
      "prism",
      "research",
    );
    expect(nova.token).toBe("@bot/nova");
    expect(nova.name).toBe("Nova");
    expect(nova).toMatchObject({ avatarTone: "prism", avatarIcon: "research" });
    expect(toRunResources([nova, skillMention("s1", "review-pr")])).toEqual([]);
    expect(mentionedBotIds([nova, nova, skillMention("s1", "review-pr")])).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(mentionedBotIds([])).toEqual([]);
  });

  test("a name with spaces becomes one whitespace-free token; the chip keeps the name", () => {
    expect(botToken("Night triage")).toBe("@bot/night-triage");
    expect(botToken("Chief of staff")).toBe("@bot/chief-of-staff");
    expect(botToken("  Q&A  bot ")).toBe("@bot/q-a-bot");
    const triage = botMention("bot-triage", "Night triage");
    expect(triage.name).toBe("Night triage");
    // Inserted from the picker, the token stays intact and the caret lands after it.
    const inserted = insertMentionToken("ask @nig", 4, 8, triage.token);
    expect(inserted.text).toBe("ask @bot/night-triage ");
    expect(inserted.caret).toBe(inserted.text.length);
    expect(removeMentionToken(inserted.text, triage.token)).toBe("ask ");
  });
});

describe("unlinkedBotTokens - a typed @bot/ token with no chip behind it", () => {
  test("flags tokens no bot chip backs and ignores linked ones", () => {
    const nova = botMention("bot-nova", "Nova");
    expect(unlinkedBotTokens("@bot/nova compare the tiers", [nova])).toEqual([]);
    expect(unlinkedBotTokens("@bot/Nova compare the tiers", [nova])).toEqual([]);
    expect(unlinkedBotTokens("@bot/Atlas compare the tiers", [nova])).toEqual(["@bot/Atlas"]);
    expect(unlinkedBotTokens("ask @bot/Atlas and @bot/Atlas again", [])).toEqual(["@bot/Atlas"]);
  });

  test("a multi-word bot's handle scans as one linked token", () => {
    const triage = botMention("bot-triage", "Night triage");
    expect(unlinkedBotTokens("@bot/night-triage name a second color", [triage])).toEqual([]);
    expect(unlinkedBotTokens("@bot/Night-Triage name a second color", [triage])).toEqual([]);
    expect(unlinkedBotTokens("@bot/night-triage and @bot/chief-of-staff", [triage])).toEqual(["@bot/chief-of-staff"]);
  });

  test("an email-like or mid-word @bot/ is not a token", () => {
    expect(unlinkedBotTokens("mail x@bot/ops now", [])).toEqual([]);
    expect(unlinkedBotTokens("nothing here", [])).toEqual([]);
  });
});

describe("parseDraftMentions - chips restored with the draft", () => {
  test("round-trips every mention kind and drops malformed entries", () => {
    const saved = [
      botMention("bot-nova", "Nova"),
      skillMention("s1", "review"),
      { kind: "thread", id: "t1", shortId: "t1short", title: "Old thread", token: "@thread/t1short" },
      { kind: "pr", repo: "acme/api", number: 7, title: "Fix auth", token: "@acme/api#7" },
      { kind: "file", repo: "acme/api", path: "src/a.ts", revision: null, token: "@acme/api:src/a.ts" },
      { kind: "bot", id: 12 },
      { kind: "nope", token: "x" },
      "junk",
    ];
    const parsed = parseDraftMentions(JSON.stringify(saved));
    expect(parsed).toHaveLength(5);
    expect(mentionedBotIds(parsed)).toEqual(["bot-nova"]);
    expect(parsed[0]).toMatchObject({ avatarTone: "blue", avatarIcon: "robot" });
  });

  test("preserves bot appearance and upgrades older drafts with safe defaults", () => {
    const saved = botMention("bot-nova", "Nova", "prism", "research");
    expect(parseDraftMentions(JSON.stringify([saved]))).toEqual([saved]);
    expect(
      parseDraftMentions(
        JSON.stringify([{ kind: "bot", id: "bot-old", name: "Old bot", token: "@bot/old-bot" }]),
      ),
    ).toEqual([botMention("bot-old", "Old bot")]);
  });

  test("nothing saved, or unreadable storage, means no chips", () => {
    expect(parseDraftMentions(null)).toEqual([]);
    expect(parseDraftMentions("{not json")).toEqual([]);
    expect(parseDraftMentions('{"kind":"bot"}')).toEqual([]);
  });
});
