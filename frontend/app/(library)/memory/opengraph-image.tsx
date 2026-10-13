// Memory preview — public/og/12-memory.png
import { ogContentType, ogImageResponse, ogSize } from "@/app/og-helper";
export const alt = "UseAgent Memory";
export const size = ogSize;
export const contentType = ogContentType;
export default function Image() { return ogImageResponse("12-memory.png"); }
