// Wiki preview — public/og/18-wiki.png
import { ogContentType, ogImageResponse, ogSize } from "@/app/og-helper";
export const alt = "UseAgent Wiki";
export const size = ogSize;
export const contentType = ogContentType;
export default function Image() { return ogImageResponse("18-wiki.png"); }
