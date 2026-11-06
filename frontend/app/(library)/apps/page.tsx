import type { Metadata } from "next";

import { AppsMarketplace } from "./apps-marketplace";

export const metadata: Metadata = {
  title: "Apps - UseAgent",
  description: "Connect the tools your team already uses.",
  openGraph: {
    title: "Apps - UseAgent",
    description: "Connect the tools your team already uses.",
    images: [{ url: "/og/07-apps.png", width: 1600, height: 900, alt: "UseAgent Apps" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Apps - UseAgent",
    description: "Connect the tools your team already uses.",
    images: ["/og/07-apps.png"],
  },
};

export default function AppsPage() {
  return (
    <AppsMarketplace />
  );
}
