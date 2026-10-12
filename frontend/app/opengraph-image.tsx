// Default site-wide preview — shown for the homepage and any page
// that does not have its own opengraph-image.tsx.
// Image: public/og/01-home.png (1600×900 UseAgent Home mockup)
import { ogContentType, ogImageResponse, ogSize } from "./og-helper";

export const alt = "UseAgent - one interface for every coding agent";
export const size = ogSize;
export const contentType = ogContentType;

export default function Image() {
  return ogImageResponse("01-home.png");
}
