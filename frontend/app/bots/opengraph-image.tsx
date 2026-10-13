// Bots page preview — public/og/05-agents.png
import { ogContentType, ogImageResponse, ogSize } from "@/app/og-helper";

export const alt = "UseAgent Bots - Always-on AI agents for your workspace";
export const size = ogSize;
export const contentType = ogContentType;

export default function Image() {
  return ogImageResponse("05-agents.png");
}
