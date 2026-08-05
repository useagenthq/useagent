/**
 * Static terminal strip beneath the code viewer. Uses the fixed `neutral-950`
 * scale (not the theme-flipping surface token) so it reads as a real IDE
 * terminal in both light and dark app themes — matching the chat TerminalPane.
 */
interface Line {
  command: string;
  output?: string;
}

const lines: Line[] = [
  { command: 'bun run typecheck', output: '✓ no type errors' },
  { command: 'bun test run-trace', output: '✓ 6 passed  (412ms)' },
  { command: 'git commit -m "Add RunTrace timeline"' },
];

export function TerminalStrip() {
  return (
    <div className='overflow-hidden rounded-2xl bg-neutral-950'>
      <div className='flex shrink-0 items-center gap-1.5 border-b border-white-alpha-10 px-4 py-2.5'>
        <span className='size-3 rounded-full bg-red-500' />
        <span className='size-3 rounded-full bg-yellow-400' />
        <span className='size-3 rounded-full bg-green-500' />
        <span className='text-mono-label ml-2 text-neutral-400'>Terminal</span>
        <span className='text-mono-label ml-auto text-neutral-600'>bash</span>
      </div>

      <div className='px-4 py-3 [font-family:var(--font-mono)] text-[13px] leading-6'>
        {lines.map((line, i) => {
          const isLast = i === lines.length - 1;
          return (
            <div key={line.command}>
              <div className='flex gap-2'>
                <span className='shrink-0 select-none text-green-400'>$</span>
                <span className='min-w-0 break-words text-neutral-100'>
                  {line.command}
                  {isLast && (
                    <span
                      className='ai-caret ml-0.5 inline-block h-4 w-2 translate-y-0.5 bg-neutral-100'
                      aria-hidden
                    />
                  )}
                </span>
              </div>
              {line.output && (
                <div className='whitespace-pre-wrap break-words pl-4 text-neutral-500'>
                  {line.output}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
