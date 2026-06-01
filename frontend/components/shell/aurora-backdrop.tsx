/**
 * Bluish mesh-aurora for the whole app shell: three blurred radial blobs
 * (blue / cyan / violet) drifting very slowly across the FULL viewport,
 * under the sidebar and the content alike (both shell columns are positioned,
 * so they paint above this absolutely-positioned first child). Pure CSS - no
 * WebGL, no JS; masked out by ~40rem so the lower canvas stays flat. Colors
 * ride the chart palette, so every theme tints its own aurora, and
 * `prefers-reduced-motion` freezes the drift (aurora-blob in globals.css).
 */
export function AuroraBackdrop() {
  return (
    <div
      aria-hidden
      className='pointer-events-none absolute inset-x-0 top-0 h-[40rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_45%,transparent)]'
    >
      <div className='aurora-blob aurora-blob-a absolute left-[-10%] top-[-30%] size-[46rem] bg-[radial-gradient(closest-side,var(--color-chart-6),transparent_72%)]' />
      <div className='aurora-blob aurora-blob-b absolute right-[-8%] top-[-38%] size-[42rem] bg-[radial-gradient(closest-side,var(--color-chart-4),transparent_72%)]' />
      <div className='aurora-blob aurora-blob-c absolute left-[32%] top-[-45%] size-[48rem] bg-[radial-gradient(closest-side,var(--color-chart-5),transparent_72%)]' />
    </div>
  );
}
