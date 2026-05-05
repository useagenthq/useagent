import { cn } from "@/utils/cn";

/**
 * Welcome mascot — a friendly line-art Skynet robot sipping coffee, a nod to
 * the inspiration's coffee-drinking alpaca. Pure monochrome stroke
 * (currentColor) so it reads correctly in both light and dark themes.
 */
export function Mascot({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="Skynet robot enjoying a coffee"
      className={cn("size-16 text-text-strong-950", className)}
    >
      {/* antenna */}
      <path d="M32 12V7" />
      <circle cx="32" cy="4.5" r="2" />
      {/* head */}
      <rect x="17" y="12" width="30" height="22" rx="7" />
      {/* ears */}
      <rect x="12" y="18" width="5" height="9" rx="2" />
      <rect x="47" y="18" width="5" height="9" rx="2" />
      {/* eyes + glasses bridge */}
      <circle cx="26" cy="23" r="3.4" />
      <circle cx="38" cy="23" r="3.4" />
      <path d="M29.4 23h5.2" />
      {/* smile */}
      <path d="M27 29q5 3 10 0" />
      {/* arm reaching for the mug */}
      <path d="M20 34q-3 4-4 6" />
      {/* coffee mug */}
      <rect x="9" y="40" width="12" height="12" rx="2" />
      <path d="M21 43q4 0 4 3.5t-4 3.5" />
      {/* steam */}
      <path d="M12 38q-2-2.5 0-5" />
      <path d="M16 38q-2-2.5 0-5" />
    </svg>
  );
}
