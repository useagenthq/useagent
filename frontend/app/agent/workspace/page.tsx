import { redirect } from "next/navigation";

// The workspace fleet overview merged into /dashboard (per-project fleet lanes +
// the model-burn Limits card now live there). Keep the old path as a redirect so
// bookmarks and in-flight links resolve.
export default function WorkspacePage() {
  redirect("/dashboard");
}
