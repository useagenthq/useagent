import type { Metadata } from "next";

import { ReviewWorkspace } from "./review-workspace";

export const metadata: Metadata = {
  title: "Pull requests - UseAgent",
  description: "Open pull requests across your connected GitHub repositories.",
  openGraph: {
    title: "Pull requests - UseAgent",
    description: "Open pull requests across your connected GitHub repositories.",
    images: [{ url: "/og/14-reviews.png", width: 1600, height: 900, alt: "UseAgent Pull Requests" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Pull requests - UseAgent",
    description: "Open pull requests across your connected GitHub repositories.",
    images: ["/og/14-reviews.png"],
  },
};

export default function ReviewPage() {
  return (
    <ReviewWorkspace />
  );
}
