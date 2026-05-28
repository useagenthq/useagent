import { cn } from '@/utils/cn';

/**
 * useAgent's 8-point asterisk brand mark (the ✳ used in the top nav, the
 * new-chat hero, run traces, and plan headers). Purely presentational —
 * size and color come from className, so the same glyph serves the black
 * hero mark and the orange model badge.
 */
export function AsteriskMark({ className }: { className?: string }) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: presentational brand glyph is hidden from assistive technology
    <svg
      viewBox='0 0 24 24'
      fill='currentColor'
      aria-hidden
      className={cn('size-6', className)}
    >
      <path d='M11 2h2v6.6l4.66-4.66 1.4 1.42L14.42 10H21v2h-6.6l4.66 4.66-1.42 1.4L13 13.42V20h-2v-6.6l-4.66 4.66-1.4-1.42L9.58 12H3v-2h6.6L4.94 5.34l1.42-1.4L11 8.6V2z' />
    </svg>
  );
}
