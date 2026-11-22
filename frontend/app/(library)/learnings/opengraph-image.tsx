// Learnings preview — public/og/17-learnings.png
import { ogContentType, ogImageResponse, ogSize } from "@/app/og-helper";
export const alt = "UseAgent Learnings";
export const size = ogSize;
export const contentType = ogContentType;
export default function Image() { return ogImageResponse("17-learnings.png"); }
