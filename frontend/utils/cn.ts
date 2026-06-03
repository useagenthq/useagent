import { borderRadii, shadows, texts } from '@/tailwind.config';
import { TEXT_STYLE_SUFFIXES } from '@/utils/cx';
import clsx from 'clsx';

/**
 * tailwind-merge configuration shared with `utils/tv.ts` (tailwind-variants).
 * The composite text styles (styles/typography.css, via utils/cx) and the
 * legacy text scale (tailwind.config) must be registered as `font-size` groups;
 * otherwise tailwind-merge treats `text-body-2-regular` etc. as text-COLORS and
 * silently drops them whenever a real color (`text-text-primary`) follows in the
 * same className.
 */
export const twMergeConfig = {
  extend: {
    classGroups: {
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

/**
 * A direct export of `clsx` without `tailwind-merge`.
 */
export const cn = clsx;
