// Adapted from the AlignUI starter (alignui/alignui-nextjs-typescript-starter), MIT License.
// Copyright (c) 2024 Doğukan Çavuş.

import { createTV } from 'tailwind-variants';

import { twMergeConfig } from '@/utils/cn';

export type { VariantProps, ClassValue } from 'tailwind-variants';

export const tv = createTV({
  twMergeConfig,
});
