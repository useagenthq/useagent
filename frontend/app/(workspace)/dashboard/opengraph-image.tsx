// Dashboard preview — public/og/04-dashboard.png
import { ogContentType, ogImageResponse, ogSize } from "@/app/og-helper";

export const alt = "UseAgent Dashboard - Your workspace at a glance";
export const size = ogSize;
export const contentType = ogContentType;

export default function Image() {
  return ogImageResponse("04-dashboard.png");
}
