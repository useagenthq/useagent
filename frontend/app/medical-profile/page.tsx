import { MedicalShell } from "@/components/application/medical/medical-shell";
import { withOg } from "@/lib/og";

export const metadata = withOg({
  title: "Medical Profile Template — React + Tailwind Admin Dashboard",
  description:
    "BoardUI Pro medical profile dashboard: patient overview, steps, sleep score, activity rings, alerts feed, and a patients data table.",
  kind: "template",
  pro: true,
});

/**
 * Figma source: Board UI → "medical profile dashboard" (node 3950:5573,
 * 1440×900).
 */
export default function MedicalProfileTemplate() {
  return <MedicalShell />;
}
