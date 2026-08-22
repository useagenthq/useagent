import { AiProfileShell } from "@/components/application/ai-profile/ai-profile-shell";
import { withOg } from "@/lib/og";

export const metadata = withOg({
  title: "AI Profile Template — React + Tailwind Admin Dashboard",
  description:
    "BoardUI Pro AI contributions profile: cover photo, contribution stats, activity heatmap, 30-day agents bar chart, and a tokens trend chart.",
  kind: "template",
  pro: true,
});

/**
 * Figma source: Board UI → "ai profile" (node 4063:5675, 1440×900).
 */
export default function AiProfileTemplate() {
  return <AiProfileShell />;
}
