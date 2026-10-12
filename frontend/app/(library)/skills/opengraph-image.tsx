// Skills preview — public/og/15-skills.png
import { ogContentType, ogImageResponse, ogSize } from "@/app/og-helper";
export const alt = "UseAgent Skills";
export const size = ogSize;
export const contentType = ogContentType;
export default function Image() { return ogImageResponse("15-skills.png"); }
