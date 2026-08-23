import { Chip } from '@/components/base/badges/chip';
import { ChevronSortDown } from '@/components/foundations/icons/chevrons';
import { cx } from '@/utils/cx';

/**
 * Shared presentational cells for the BoardUI data-table recipe (react-aria
 * `Table` driven by @tanstack/react-table). Both the dashboard Recent runs card
 * and the /agent/runs list render these, so the sort affordance, the empty
 * placeholder and the pulse-dot status chip stay one implementation.
 */

/** Sortable-column chevron: dim when unsorted, flips on ascending. */
export function SortChevron({ dir }: { dir: false | 'asc' | 'desc' }) {
  return (
    <ChevronSortDown
      className={cx(
        'size-6 shrink-0 transition-[transform,color] duration-150',
        dir === 'asc' && 'rotate-180',
        dir ? 'text-text-secondary' : 'text-text-tertiary',
      )}
    />
  );
}

/** Placeholder for an absent cell value (no engine, no repo, no duration). */
export function Muted() {
  return <span className='text-body-2-regular text-text-tertiary'>-</span>;
}

/** Status-chip palette shared by every run surface (queued/running/…). */
export type StatusChipColor = 'yellow' | 'lime' | 'rose' | 'soft';

/** Labeled status chip with a leading dot that breathes while `pulse` is set. */
export function StatusChip({
  color,
  label,
  pulse = false,
}: {
  color: StatusChipColor;
  label: string;
  pulse?: boolean;
}) {
  return (
    <Chip variant='caption' color={color} className='gap-1'>
      <span
        aria-hidden
        className={cx('size-1.5 rounded-full bg-current', pulse && 'animate-pulse')}
      />
      {label}
    </Chip>
  );
}
