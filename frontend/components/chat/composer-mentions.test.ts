import { describe, expect, test } from "bun:test";
import {
  detectMentionTrigger,
  fileMention,
  insertMentionToken,
  type Mention,
  mentionKey,
  mentionsReducer,
  mentionsToRunResources,
  prMention,
  removeMentionToken,
  shortThreadId,
  skillMention,
  threadMention,
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
