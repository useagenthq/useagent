import { borderRadii, shadows, texts } from '@/tailwind.config';
import { TEXT_STYLE_SUFFIXES } from '@/utils/cx';
import clsx, { type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

export { type ClassValue } from 'clsx';

export const twMergeConfig = {
  extend: {
    classGroups: {
      // Legacy AlignUI text scale (tailwind.config) + the BoardUI composite
      // text styles (styles/typography.css, via utils/cx). Without the latter,
      // cnExt classifies `text-body-2-regular` etc. as text-COLORS and silently
      // drops them whenever a real color (`text-text-primary`) follows in the
      // same className — which un-sized every Markdown block in the chat
      // timeline down to the inherited 16px default.
      'font-size': [
        {
          text: [...Object.keys(texts), ...TEXT_STYLE_SUFFIXES],
        },
      ],
      shadow: [
        {
          shadow: Object.keys(shadows),
        },
      ],
      rounded: [
        {
          rounded: Object.keys(borderRadii),
        },
      ],
    },
  },
};

const customTwMerge = extendTailwindMerge(twMergeConfig);

/**
 * Utilizes `clsx` with `tailwind-merge`, use in cases of possible class conflicts.
 */
export function cnExt(...classes: ClassValue[]) {
  return customTwMerge(clsx(...classes));
}

/**
 * A direct export of `clsx` without `tailwind-merge`.
 */
export const cn = clsx;
