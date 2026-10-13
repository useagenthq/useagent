// Playbooks preview — public/og/13-playbooks.png
import { ogContentType, ogImageResponse, ogSize } from "@/app/og-helper";
export const alt = "UseAgent Playbooks";
export const size = ogSize;
export const contentType = ogContentType;
export default function Image() { return ogImageResponse("13-playbooks.png"); }
