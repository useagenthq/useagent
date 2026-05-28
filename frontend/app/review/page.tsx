import type { Metadata } from "next";

import { AppShell } from "@/components/shell/app-shell";
import { LibrarySidebar } from "@/components/shell/library-sidebar";
import { ReviewWorkspace } from "./review-workspace";

export const metadata: Metadata = {
  title: "Pull requests - useAgent",
  description: "Open pull requests across your connected GitHub repositories.",
};

export default function ReviewPage() {
  return (
    <AppShell sidebar={<LibrarySidebar active="reviews" />}>
      <ReviewWorkspace />
    </AppShell>
  );
}
