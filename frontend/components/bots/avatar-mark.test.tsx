import { describe, expect, test } from "bun:test";
import { RiFileLine } from "@remixicon/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MentionRowMark } from "@/components/chat/mention-row-mark";
import { AvatarMark, botOrb } from "./avatar-mark";
import { BOT_AVATAR_TONES } from "./types";

describe("AvatarMark", () => {
  test("is an orb on the theme's state ramp with the role glyph centered on it", () => {
    const html = renderToStaticMarkup(<AvatarMark tone="violet" icon="research" size="size-8" />);
    expect(html).toContain('class="orb ');
    expect(html).toContain("--orb-tone:hsl(var(--feature-base))");
    expect(html).toContain('data-variant="solid"');
    expect(html).toContain("<svg");
    expect(html).toContain("size-4");
  });

  test("the picker offers the prism ball and it renders as the prism variant", () => {
    expect(BOT_AVATAR_TONES).toContain("prism");
    expect(botOrb("prism")).toEqual({ variant: "prism" });
    expect(renderToStaticMarkup(<AvatarMark tone="prism" icon="compass" />)).toContain('data-variant="prism"');
  });

  test("an unknown tone falls back to the primary orb", () => {
    expect(botOrb("teal")).toEqual({ tone: "primary" });
  });

  test("the state dot rides the orb", () => {
    const html = renderToStaticMarkup(<AvatarMark tone="blue" icon="robot" state="working" />);
    expect(html).toContain("bg-success-base");
    expect(renderToStaticMarkup(<AvatarMark tone="blue" icon="robot" />)).not.toContain("bg-success-base");
  });
});

describe("one avatar language", () => {
  test("mention rows render bot appearance through AvatarMark", () => {
    const html = renderToStaticMarkup(
      <MentionRowMark
        bot={{ avatarTone: "prism", avatarIcon: "research" }}
        icon={RiFileLine}
      />,
    );
    expect(html).toContain('class="orb ');
    expect(html).toContain('data-variant="prism"');
    expect(html).not.toContain("remixicon-file-line");
  });

  test("non-bot mention rows keep their resource icon", () => {
    const html = renderToStaticMarkup(<MentionRowMark icon={RiFileLine} />);
    expect(html).toContain("<svg");
    expect(html).toContain("text-text-secondary");
    expect(html).not.toContain('class="orb ');
  });
});
