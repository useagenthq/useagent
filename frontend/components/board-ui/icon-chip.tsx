// Colored icon chip in the BoardUI Pro "plugin icon" style: a tinted rounded
// square holding a glyph, used to give menus/lists brand color instead of flat
// monochrome line icons. The look is adapted from BoardUI Pro (boardui.com,
// licensed); re-expressed with our own tokens + @remixicon glyphs and a neutral
// name per the vendoring rule (no third-party product name in identifiers).

import type { ComponentType } from 'react';

import { cx as cn } from "@/utils/cx";

type IconComponent = ComponentType<{
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}>;

export type ChipTone = 'blue' | 'green' | 'purple' | 'orange' | 'red' | 'neutral';

// Brand tints ride the raw ramp (consistent across light/dark) with a soft alpha
// fill; neutral uses the theme-aware surface token.
const TONE: Record<ChipTone, string> = {
  blue: 'bg-blue-500/15 text-blue-500',
  green: 'bg-green-500/15 text-green-600',
  purple: 'bg-purple-500/15 text-purple-500',
  orange: 'bg-orange-500/15 text-orange-500',
  red: 'bg-red-500/15 text-red-500',
  neutral: 'bg-background-secondary-default text-text-secondary',
};

const SIZE = {
  sm: 'size-6 rounded-md',
  md: 'size-7 rounded-lg',
} as const;

/**
 * A tinted rounded chip with a centered glyph. Defaults to a medium neutral
 * chip; pass a `tone` for a brand-colored fill.
 */
export function IconChip({
  icon: Icon,
  tone = 'neutral',
  size = 'md',
  className,
  glyphClassName,
}: {
  icon: IconComponent;
  tone?: ChipTone;
  size?: keyof typeof SIZE;
  className?: string;
  glyphClassName?: string;
}) {
  return (
    <span className={cn('flex shrink-0 items-center justify-center', SIZE[size], TONE[tone], className)}>
      <Icon className={cn(size === 'sm' ? 'size-3.5' : 'size-4', glyphClassName)} aria-hidden />
    </span>
  );
}
