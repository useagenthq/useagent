import { createHighlighter, type Highlighter } from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

/**
 * Server-rendered, syntax-highlighted read-only viewer. Uses Shiki with the
 * pure-JS regex engine (no WASM) so it bundles cleanly under Turbopack, and a
 * light/dark dual theme that follows the app's `.dark` class. The highlighter
 * is memoized at module scope so repeated renders don't re-initialize grammars.
 */
let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-light', 'github-dark'],
      langs: ['tsx'],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

// Line numbers + dark-theme switching, scoped to the viewer.
const VIEWER_CSS = `
.code-shiki pre {
  margin: 0;
  padding: 0.875rem 0;
  overflow-x: auto;
  background-color: transparent !important;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.55;
}
.code-shiki code { counter-reset: step; counter-increment: step 0; display: grid; }
.code-shiki .line::before {
  content: counter(step);
  counter-increment: step;
  display: inline-block;
  width: 2rem;
  margin-right: 1.25rem;
  padding-right: 0.75rem;
  text-align: right;
  color: color-mix(in srgb, currentColor 32%, transparent);
  border-right: 1px solid color-mix(in srgb, currentColor 12%, transparent);
}
.code-shiki .line { padding: 0 1rem; }
.dark .code-shiki span { color: var(--shiki-dark) !important; }
`;

export async function CodeViewer({
  code,
  lang = 'tsx',
}: {
  code: string;
  lang?: string;
}) {
  const highlighter = await getHighlighter();
  const html = highlighter.codeToHtml(code, {
    lang,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: 'light',
  });

  return (
    <div className='overflow-hidden rounded-2xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-xs'>
      <style dangerouslySetInnerHTML={{ __html: VIEWER_CSS }} />
      <div
        className='code-shiki min-h-0 overflow-auto text-text-strong-950'
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
