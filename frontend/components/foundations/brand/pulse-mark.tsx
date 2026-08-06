import { cn } from '@/utils/cn';

/**
 * Skynet's radar-pulse brand mark: a solid core ringed by concentric pulses.
 * At rest it's the core + one faint steady ring; when `active` (an agent is
 * working) two rings contract INWARD on a staggered loop - the "thinking/
 * working" tell. Presentational like AsteriskMark: size + color come from
 * className via currentColor, so it themes correctly in light and dark (the
 * prototype's #fff is replaced by currentColor here).
 */
export function PulseMark({
  className,
  active = false,
}: {
  className?: string;
  active?: boolean;
}) {
  return (
    <svg
      viewBox='0 0 24 24'
      fill='none'
      aria-hidden
      className={cn('size-6', className)}
    >
      {/* Solid core */}
      <circle cx='12' cy='12' r='2.4' fill='currentColor' />
      {active ? (
        <>
          {/* Two rings collapsing inward (r 10.5 -> 3) while fading in, staggered
              half a cycle so the pulse reads continuous. */}
          <circle cx='12' cy='12' r='10.5' stroke='currentColor' strokeWidth='1.6' opacity='0'>
            <animate attributeName='r' from='10.5' to='3' dur='1.8s' repeatCount='indefinite' />
            <animate attributeName='opacity' from='0' to='0.75' dur='1.8s' repeatCount='indefinite' />
          </circle>
          <circle cx='12' cy='12' r='10.5' stroke='currentColor' strokeWidth='1.6' opacity='0'>
            <animate attributeName='r' from='10.5' to='3' dur='1.8s' begin='-0.9s' repeatCount='indefinite' />
            <animate attributeName='opacity' from='0' to='0.75' dur='1.8s' begin='-0.9s' repeatCount='indefinite' />
          </circle>
        </>
      ) : (
        /* Rest: a single faint steady ring around the core. */
        <circle cx='12' cy='12' r='7.5' stroke='currentColor' strokeWidth='1.6' opacity='0.35' />
      )}
    </svg>
  );
}
