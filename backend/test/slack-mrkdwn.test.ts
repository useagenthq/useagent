/**
 * Markdown -> Slack mrkdwn conversion (src/slack/mrkdwn.ts, ported from
 * QM's src/slack/mrkdwn.ts, MIT). Covers the required cases plus the
 * ported converter's other faithful behaviors (italic, strikethrough, tables,
 * dividers, mass-mention safety, plain text left alone).
 */
import { describe, expect, test } from "bun:test";
import {
  toSlackMrkdwn,
  neutralizeMassMentions,
  slackPlainLabel,
} from "../src/slack/mrkdwn";
import { composeSlackReplyText } from "../src/slack/reply";
import { explicitOutputLinks, replaceOutputLinks } from "../src/artifacts/output-links";

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

  test("a link to a sandbox path keeps only its label (the file arrives as an upload)", () => {
    expect(toSlackMrkdwn("[Download the PDF](/home/user/work/report.pdf)")).toBe("Download the PDF");
    expect(toSlackMrkdwn("[Docs](https://useagent.org/docs)")).toBe("<https://useagent.org/docs|Docs>");
  });

  test("`code` spans pass through untouched", () => {
    expect(toSlackMrkdwn("run `git **status**` now")).toBe("run `git **status**` now");
    expect(toSlackMrkdwn("`echo hi` and text")).toBe("`echo hi` and text");
  });

  test("[label](url) -> <url|label>, images too", () => {
    expect(toSlackMrkdwn("see [GitHub](https://github.com)")).toBe("see <https://github.com|GitHub>");
    expect(toSlackMrkdwn("[plain](https://x.io)")).toBe("<https://x.io|plain>");
    expect(toSlackMrkdwn("![alt](https://x.io/a.png)")).toBe("<https://x.io/a.png|alt>");
    expect(toSlackMrkdwn(String.raw`[report\[final\].pdf](https://x.test/d)`)).toBe(
      "<https://x.test/d|report[final].pdf>",
    );
  });

  test("fenced code block passes through untouched", () => {
    const fenced = "```\n# not a header\n- not a bullet\n**not bold**\n```";
    expect(toSlackMrkdwn(fenced)).toBe(fenced);
  });

  test("decodes serializer escapes without activating Slack formatting or broadcasts", () => {
    const input = String.raw`Done\. \*not bold\* \# not a heading \<\!channel\> \`not code\``;
    const output = toSlackMrkdwn(input);
    expect(output).not.toContain("\\");
    expect(output).toContain("Done.");
    expect(output).not.toContain("*not bold*");
    expect(output).not.toContain("<!channel>");
    expect(output).not.toContain("`not code`");
  });

  test("converts actual rewritten artifact Markdown without visible escape slashes", () => {
    const markdown = String.raw`Done. Report: [report\[final\].pdf](result.pdf)`;
    const links = explicitOutputLinks(markdown, "/work");
    const rewritten = replaceOutputLinks(markdown, links, new Map([
      ["/work/result.pdf", { preview: "https://files.test/preview", download: "https://files.test/download" }],
    ]));
    expect(rewritten).toContain("Done\\.");
    expect(toSlackMrkdwn(rewritten)).toBe("Done. Report: <https://files.test/download|report[final].pdf>");
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

  test("metadata labels cannot inject mrkdwn, links, layout, or broadcasts", () => {
    expect(slackPlainLabel(" *Child*\n<!channel> <https://evil.test|click> `code` ")).toBe(
      "Child @​channel &lt;https://evil.test|click&gt; code",
    );
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
