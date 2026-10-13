// Settings preview — public/og/08-customize.png
import { ogContentType, ogImageResponse, ogSize } from "@/app/og-helper";

export const alt = "UseAgent Settings - Customize your workspace";
export const size = ogSize;
export const contentType = ogContentType;

export default function Image() {
  return ogImageResponse("08-customize.png");
}
