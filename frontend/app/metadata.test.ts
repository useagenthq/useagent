import { describe, expect, mock, test } from "bun:test";

mock.module("next/font/google", () => ({
  Inter: () => ({ variable: "font-sans" }),
  Inter_Tight: () => ({ variable: "font-display" }),
  JetBrains_Mono: () => ({ variable: "font-mono" }),
}));

// Mock next/headers so generateMetadata can resolve the base URL in tests.
mock.module("next/headers", () => ({
  headers: () =>
    Promise.resolve(
      new Map([
        ["host", "app.useagent.org"],
        ["x-forwarded-proto", "https"],
      ]),
    ),
}));

import { generateMetadata as generateLoginMetadata } from "./login/[[...login]]/page";
import ogImage, {
  alt as ogAlt,
  contentType as ogContentType,
  size as ogSize,
} from "./opengraph-image";
import twitterImage, {
  alt as twitterAlt,
  contentType as twitterContentType,
  size as twitterSize,
} from "./twitter-image";

describe("site-wide metadata (issue #124)", () => {
  test("root layout exports correct metadataBase, openGraph, and twitter metadata", async () => {
    const { generateMetadata: rootGenerateMetadata } = await import("./layout");
    const rootMetadata = await rootGenerateMetadata();
    expect(rootMetadata.metadataBase?.toString()).toBe("https://app.useagent.org/");
    expect(rootMetadata.title).toBe("UseAgent - one interface for every coding agent");
    expect(rootMetadata.description).toBe(
      "Run coding agents in isolated workspaces with durable context, automations, and audit trails.",
    );

    expect(rootMetadata.openGraph).toMatchObject({
      title: "UseAgent - one interface for every coding agent",
      description:
        "Run coding agents in isolated workspaces with durable context, automations, and audit trails.",
      url: "https://app.useagent.org",
      siteName: "UseAgent",
      type: "website",
    });

    expect(rootMetadata.twitter).toMatchObject({
      card: "summary_large_image",
      title: "UseAgent - one interface for every coding agent",
      description:
        "Run coding agents in isolated workspaces with durable context, automations, and audit trails.",
    });
  });

  test("opengraph-image and twitter-image conform to Next.js route specifications", async () => {
    expect(ogSize).toEqual({ width: 1600, height: 900 });
    expect(ogContentType).toBe("image/png");
    expect(ogAlt).toBe("UseAgent - one interface for every coding agent");

    expect(twitterSize).toEqual({ width: 1600, height: 900 });
    expect(twitterContentType).toBe("image/png");
    expect(twitterAlt).toBe("UseAgent - one interface for every coding agent");

    const ogResponse = await ogImage();
    expect(ogResponse.status).toBe(200);

    const twResponse = await twitterImage();
    expect(twResponse.status).toBe(200);
  });

  test("login page metadata dynamically adapts for ref=hacktoberfest", async () => {
    const defaultMeta = await generateLoginMetadata({
      searchParams: Promise.resolve({}),
    });
    expect(defaultMeta.description).toBe("Sign in to your UseAgent workspace.");
    expect(defaultMeta.openGraph?.description).toBe("Sign in to your UseAgent workspace.");
    expect(defaultMeta.twitter?.description).toBe("Sign in to your UseAgent workspace.");

    const hacktoberfestMeta = await generateLoginMetadata({
      searchParams: Promise.resolve({ ref: "hacktoberfest" }),
    });
    expect(hacktoberfestMeta.description).toBe("Try UseAgent free with no API key.");
    expect(hacktoberfestMeta.openGraph?.description).toBe("Try UseAgent free with no API key.");
    expect(hacktoberfestMeta.twitter?.description).toBe("Try UseAgent free with no API key.");

    const caseInsensitiveMeta = await generateLoginMetadata({
      searchParams: Promise.resolve({ ref: "Hacktoberfest" }),
    });
    expect(caseInsensitiveMeta.description).toBe("Try UseAgent free with no API key.");

    const arrayRefMeta = await generateLoginMetadata({
      searchParams: Promise.resolve({ ref: ["hacktoberfest", "other"] }),
    });
    expect(arrayRefMeta.description).toBe("Try UseAgent free with no API key.");
  });
});
