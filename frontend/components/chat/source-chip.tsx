// An inline citation pill for streamed answers: a tiny favicon square + the
// source domain, sized to sit INSIDE flowing markdown text (beautiful-ui
// "Streaming Text" grammar). Rendered wherever answer text carries source
// attributions; the retrieval layer decides placement, this only draws.

import { Chip } from "@/components/base/badges/chip";

const LETTER_TONES = [
  "bg-sky-100 text-sky-600",
  "bg-lime-100 text-lime-600",
  "bg-amber-100 text-amber-600",
  "bg-purple-100 text-purple-600",
  "bg-rose-100 text-rose-600",
] as const;

/** Stable tone per domain so repeated citations of one source match. */
function toneFor(domain: string): string {
  let hash = 0;
  for (const ch of domain) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return LETTER_TONES[Math.abs(hash) % LETTER_TONES.length];
}

export function SourceChip({ domain, href }: { domain: string; href?: string }) {
  const letter = (
    <span
      aria-hidden
      className={`flex size-3.5 shrink-0 items-center justify-center rounded-[4px] text-[9px] font-semibold uppercase leading-none ${toneFor(domain)}`}
    >
      {domain.charAt(0)}
    </span>
  );
  const chip = (
    <Chip
      color="soft"
      className="max-w-72 gap-1 rounded-full py-px align-middle"
      data-testid="source-chip"
    >
      {letter}
      <span className="truncate">{domain}</span>
    </Chip>
  );
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open source: ${domain}`}
        className="inline-flex translate-y-[-1px] rounded-full outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        {chip}
      </a>
    );
  }
  return <span className="inline-flex translate-y-[-1px]">{chip}</span>;
}
