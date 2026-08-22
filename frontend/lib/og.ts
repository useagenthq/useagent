import type { Metadata } from "next";

/**
 * Social-card helper for docs and template pages.
 *
 * Every component and template page already exports a `title` and a
 * `description`; `withOg` takes exactly those, keeps them as the page
 * metadata, and adds an `openGraph` / `twitter` image pointing at the
 * `/og` route, which renders a 1200×630 card from the same two strings. So
 * nothing has to be kept in sync by hand - change the page's title and the
 * card follows.
 *
 * The heading on the card is the title with its trailing SEO clause cut off
 * ("Button Group - React Component" → "Button Group"), since the card has
 * the BoardUI mark to say where it comes from.
 */

export type OgKind = "component" | "template" | "page";

type OgInput = Pick<Metadata, "title" | "description" | "alternates"> & {
  title: string;
  description: string;
  /** Shown as a small caption over the heading ("Component" / "Template"). */
  kind?: OgKind;
  /** Adds the Pro pill to the card. */
  pro?: boolean;
  /** Override the heading when the title's first clause isn't the right one. */
  heading?: string;
};

/** "Button Group - React Component (Pro)" → "Button Group". */
export function ogHeading(title: string) {
  return title.split(/\s+[-–—]\s+/)[0].trim();
}

/** The card already carries the BoardUI mark and the Pro pill, so the SEO
 *  sign-off at the end of a description is dead weight on a 3-line clamp. */
export function ogDescription(description: string) {
  return description
    .replace(/\s*(?:A BoardUI Pro (?:component|template)|Part of the BoardUI dashboard design system)\.?\s*$/i, "")
    .trim();
}

export function ogImageUrl({
  title,
  description,
  kind = "component",
  pro = false,
  heading,
}: OgInput) {
  const params = new URLSearchParams({
    title: heading ?? ogHeading(title),
    description: ogDescription(description),
    kind,
  });
  if (pro) params.set("pro", "1");
  return `/og?${params.toString()}`;
}

export function withOg(input: OgInput): Metadata {
  const { kind, pro, heading, ...metadata } = input;
  void kind;
  void pro;
  void heading;
  const url = ogImageUrl(input);
  const alt = `${input.heading ?? ogHeading(input.title)} - BoardUI`;
  return {
    ...metadata,
    openGraph: {
      title: input.title,
      description: input.description,
      type: "website",
      siteName: "BoardUI",
      images: [{ url, width: 1200, height: 630, alt }],
    },
    twitter: {
      card: "summary_large_image",
      title: input.title,
      description: input.description,
      images: [url],
    },
  };
}
