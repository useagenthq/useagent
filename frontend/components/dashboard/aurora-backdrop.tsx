/**
 * Bluish mesh-aurora for the dashboard canvas: three blurred radial blobs
 * (blue / cyan / violet) drifting very slowly. Sits at -z-20, one layer UNDER
 * the app shell's halftone dot band (-z-10), so the dots read as stars over
 * the glow. Pure CSS - no WebGL, no JS; the layer is masked out by ~34rem so
 * the charts below sit on the flat canvas. Colors ride the chart palette, so
 * every theme tints its own aurora, and `prefers-reduced-motion` freezes the
 * drift (aurora-blob in globals.css).
 */
export function AuroraBackdrop() {
  return (
    <div
      aria-hidden
      className='pointer-events-none absolute inset-x-0 top-0 -z-20 h-[34rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_45%,transparent)]'
    >
      <div className='aurora-blob aurora-blob-a absolute left-[-12%] top-[-30%] size-[42rem] bg-[radial-gradient(closest-side,var(--color-chart-6),transparent_72%)]' />
      <div className='aurora-blob aurora-blob-b absolute right-[-8%] top-[-38%] size-[38rem] bg-[radial-gradient(closest-side,var(--color-chart-4),transparent_72%)]' />
      <div className='aurora-blob aurora-blob-c absolute left-[30%] top-[-45%] size-[44rem] bg-[radial-gradient(closest-side,var(--color-chart-5),transparent_72%)]' />
    </div>
  );
}
