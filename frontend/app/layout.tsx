import type { Metadata, Viewport } from 'next';
import { Inter, Inter_Tight, JetBrains_Mono } from 'next/font/google';

import { cx } from '@/utils/cx';
import { Providers } from '@/app/providers';

import './globals.css';

const fontSans = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const fontMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

// Licensed-safe display companion to Inter. Keep it on the existing display
// utilities so dense product chrome, chat, and tool output remain in Inter.
const fontDisplay = Inter_Tight({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'useAgent - one interface for every coding agent',
  description: 'Run coding agents in isolated workspaces with durable context, automations, and audit trails.',
};

// `viewportFit: 'cover'` makes iOS report real safe-area insets, so the pinned
// session composer's `pb-[max(1rem,env(safe-area-inset-bottom))]` can clear the
// home indicator (env() resolves to 0 without it).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang='en'
      suppressHydrationWarning
      className={cx(
        fontSans.variable,
        fontMono.variable,
        fontDisplay.variable,
        'antialiased'
      )}
    >
      <body className='bg-background-primary-default text-text-primary'>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
