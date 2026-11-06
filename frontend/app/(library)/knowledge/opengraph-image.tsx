// Knowledge preview — public/og/11-knowledge.png
import { ogContentType, ogImageResponse, ogSize } from "@/app/og-helper";
export const alt = "UseAgent Knowledge";
export const size = ogSize;
export const contentType = ogContentType;
export default function Image() { return ogImageResponse("11-knowledge.png"); }
