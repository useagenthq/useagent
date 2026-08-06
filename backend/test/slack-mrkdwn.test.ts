/**
 * Markdown -> Slack mrkdwn conversion (src/slack/mrkdwn.ts, ported from the
 * user's QM bot: reference-eval/src/slack/mrkdwn.ts). Covers the required cases plus the
 * ported converter's other faithful behaviors (italic, strikethrough, tables,
 * dividers, mass-mention safety, plain text left alone).
 */
import { describe, expect, test } from "bun:test";
import { toSlackMrkdwn, neutralizeMassMentions } from "../src/slack/mrkdwn";
import { composeSlackReplyText } from "../src/slack/reply";

describe("toSlackMrkdwn — required cases", () => {
  test("**bold** -> *bold* (the literal-asterisks bug)", () => {
    expect(toSlackMrkdwn("**bold**")).toBe("*bold*");
    expect(toSlackMrkdwn("use **bold** here")).toBe("use *bold* here");
    expect(toSlackMrkdwn("__also bold__")).toBe("*also bold*");
  });

  test("## heading -> *heading* (mrkdwn has no headings in a text field)", () => {
    expect(toSlackMrkdwn("## Heading")).toBe("*Heading*");
    expect(toSlackMrkdwn("# Title")).toBe("*Title*");
    expect(toSlackMrkdwn("### Deep\nbody")).toBe("*Deep*\nbody");
    expect(toSlackMrkdwn("## **Summary**")).toBe("*Summary*");
  });

  test("- bullets stay bullets (rendered as •, not mangled)", () => {
    expect(toSlackMrkdwn("- one\n- two")).toBe("• one\n• two");
    expect(toSlackMrkdwn("* star\n+ plus")).toBe("• star\n• plus");
    expect(toSlackMrkdwn("- **Auth** creds")).toBe("• *Auth* creds");
    expect(toSlackMrkdwn("1. first\n2. second")).toBe("1. first\n2. second"); // ordered left alone
  });

  test("`code` spans pass through untouched", () => {
    expect(toSlackMrkdwn("run `git **status**` now")).toBe("run `git **status**` now");
    expect(toSlackMrkdwn("`echo hi` and text")).toBe("`echo hi` and text");
  });

  test("[label](url) -> <url|label>, images too", () => {
    expect(toSlackMrkdwn("see [GitHub](https://github.com)")).toBe("see <https://github.com|GitHub>");
    expect(toSlackMrkdwn("[plain](https://x.io)")).toBe("<https://x.io|plain>");
    expect(toSlackMrkdwn("![alt](https://x.io/a.png)")).toBe("<https://x.io/a.png|alt>");
  });

  test("fenced code block passes through untouched", () => {
    const fenced = "```\n# not a header\n- not a bullet\n**not bold**\n```";
    expect(toSlackMrkdwn(fenced)).toBe(fenced);
  });
});

describe("toSlackMrkdwn — ported faithful behaviors", () => {
  test("italic *x* -> _x_; bold-inside-text not mangled by the italic pass", () => {
    expect(toSlackMrkdwn("*italic*")).toBe("_italic_");
    expect(toSlackMrkdwn("_already_")).toBe("_already_");
    expect(toSlackMrkdwn("use **bold** not *thin*")).toBe("use *bold* not _thin_");
  });

  test("strikethrough ~~x~~ -> ~x~", () => {
    expect(toSlackMrkdwn("~~gone~~")).toBe("~gone~");
  });

  test("horizontal rule -> divider", () => {
    expect(toSlackMrkdwn("above\n---\nbelow")).toBe("above\n──────────\nbelow");
  });

  test("GFM table -> aligned monospace block", () => {
    expect(toSlackMrkdwn("| Name | Score |\n|------|-------|\n| Alice | 91 |\n| Bo | 7 |")).toBe(
      "```\nName  | Score\n------+------\nAlice | 91\nBo    | 7\n```",
    );
  });

  test("encoded mass mentions are defused, plain text left alone", () => {
    expect(neutralizeMassMentions("ping <!channel> now")).toBe("ping @​channel now");
    expect(toSlackMrkdwn("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(toSlackMrkdwn("file_name_here")).toBe("file_name_here");
    expect(toSlackMrkdwn("")).toBe("");
  });

  test("full agent reply converts end-to-end (no leftover markdown)", () => {
    const md = [
      "# GitHub access",
      "",
      "1. **Git commands** - I can run `git` directly.",
      "2. **GitHub API** - via [the REST API](https://api.github.com).",
      "",
      "- You provide *authentication*",
    ].join("\n");
    const out = toSlackMrkdwn(md);
    expect(out).not.toContain("**");
    expect(out).not.toMatch(/^#/m);
    expect(out).not.toMatch(/\]\(/);
    expect(out).toContain("*Git commands*");
    expect(out).toContain("<https://api.github.com|the REST API>");
    expect(out).toContain("`git`");
    expect(out).toContain("• You provide _authentication_");
  });
});

describe("composeSlackReplyText wires the converter into the reply path", () => {
  test("completed run converts its Markdown summary to mrkdwn", () => {
    expect(composeSlackReplyText("completed", "**Done** with [x](https://x.io)")).toBe(
      "*Done* with <https://x.io|x>",
    );
  });

  test("empty summary falls back to Done.", () => {
    expect(composeSlackReplyText("completed", "")).toBe("Done.");
    expect(composeSlackReplyText("completed", null)).toBe("Done.");
  });

  test("failed run keeps the warning prefix and converts the reason", () => {
    expect(composeSlackReplyText("failed", "**boom**")).toBe(":warning: Run failed: *boom*");
    expect(composeSlackReplyText("failed", null)).toBe(":warning: Run failed.");
  });

  test("plain-prose summary (the mock engine's) is unchanged", () => {
    const s = "3 tools, edited 1 files, ran 2 commands";
    expect(composeSlackReplyText("completed", s)).toBe(s);
  });
});
