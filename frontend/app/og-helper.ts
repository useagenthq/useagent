import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Shared helper used by every route-level opengraph-image.tsx.
// Returns the image from public/og/<filename> as a PNG Response.
export async function ogImageResponse(filename: string): Promise<Response> {
  const filePath = join(process.cwd(), "public", "og", filename);
  const buffer = await readFile(filePath);
  return new Response(buffer, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400, s-maxage=86400",
    },
  });
}

export const ogSize = { width: 1600, height: 900 };
export const ogContentType = "image/png";
