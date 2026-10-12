import { readFile } from "node:fs/promises";
import { join } from "node:path";

// The default site-wide Open Graph image shown when any UseAgent link is
// shared without a more-specific page-level og:image override.
// Source: public/og/01-home.png — 1600×900 UseAgent Home feature mockup.
export const alt = "UseAgent - one interface for every coding agent";
export const size = {
  width: 1600,
  height: 900,
};
export const contentType = "image/png";

export default async function Image() {
  const filePath = join(process.cwd(), "public", "og", "01-home.png");
  const buffer = await readFile(filePath);
  return new Response(buffer, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400, s-maxage=86400",
    },
  });
}
