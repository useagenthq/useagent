import { redirect } from "next/navigation";

// `/session/new` was an unwired design exploration ("Where should we begin?").
// The canonical, backend-wired kickoff surface is `/agent/new`, so this route
// now just redirects there (server-side) and every in-app link points straight
// at `/agent/new`.
export default function NewSessionPage() {
  redirect("/agent/new");
}
