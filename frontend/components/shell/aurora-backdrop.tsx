/**
 * Bluish mesh-aurora for the whole app shell: three blurred radial blobs
 * (blue / cyan / violet) drifting very slowly across the FULL viewport width,
 * under the sidebar and the content alike (both shell columns are positioned,
 * so they paint above this absolutely-positioned first child). Pure CSS - no
 * WebGL, no JS. Confined to a ~15rem TOP BAND (roughly the top fifth of a
 * tall viewport) and masked out before the band ends, so the body canvas
 * stays flat - a crown of light, not a half-page wash. Blob offsets are in
 * rem (not %) so their bright cores sit just above the band and only the
 * glow tail reaches in. Colors ride the chart palette, so every theme tints
 * its own aurora, and `prefers-reduced-motion` freezes the drift
 * (aurora-blob in globals.css).
 */
export function AuroraBackdrop() {
  return (
    <div
      aria-hidden
      className='pointer-events-none absolute inset-x-0 top-0 h-[15rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_20%,transparent_95%)]'
    >
      <div className='aurora-blob aurora-blob-a absolute left-[-10%] top-[-18rem] size-[46rem] bg-[radial-gradient(closest-side,var(--color-chart-6),transparent_72%)]' />
      <div className='aurora-blob aurora-blob-b absolute right-[-8%] top-[-17rem] size-[42rem] bg-[radial-gradient(closest-side,var(--color-chart-4),transparent_72%)]' />
      <div className='aurora-blob aurora-blob-c absolute left-[32%] top-[-20rem] size-[48rem] bg-[radial-gradient(closest-side,var(--color-chart-5),transparent_72%)]' />
      <div className='bg-halftone absolute inset-0' />
    </div>
  );
}
