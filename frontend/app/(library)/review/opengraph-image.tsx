// Review preview — public/og/14-reviews.png
import { ogContentType, ogImageResponse, ogSize } from "@/app/og-helper";
export const alt = "UseAgent Reviews";
export const size = ogSize;
export const contentType = ogContentType;
export default function Image() { return ogImageResponse("14-reviews.png"); }
