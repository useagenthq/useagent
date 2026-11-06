// Apps preview — public/og/07-apps.png
import { ogContentType, ogImageResponse, ogSize } from "@/app/og-helper";
export const alt = "UseAgent Apps";
export const size = ogSize;
export const contentType = ogContentType;
export default function Image() { return ogImageResponse("07-apps.png"); }
