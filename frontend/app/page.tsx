import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "New thread",
  description: "Start a direct conversation or a sandbox-backed task.",
};

/**
 * Chat and Agent share one durable thread entrypoint. The previous `/api/chat`
 * route remains available as a server rollback path, but the product no longer
 * exposes a second stateless conversation surface.
 */
export default function Home() {
  redirect("/agent/new");
}
