import type { Metadata, Viewport } from 'next';
import { Inter, Inter_Tight, JetBrains_Mono } from 'next/font/google';
import { headers } from 'next/headers';

import { cx } from '@/utils/cx';
import { Providers } from '@/app/providers';
import { RoutePrefetch } from '@/components/shell/route-prefetch';

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

const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.useagent.org';

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: 'UseAgent - one interface for every coding agent',
  description:
    'Run coding agents in isolated workspaces with durable context, automations, and audit trails.',
  openGraph: {
    title: 'UseAgent - one interface for every coding agent',
    description:
      'Run coding agents in isolated workspaces with durable context, automations, and audit trails.',
    url: appUrl,
    siteName: 'UseAgent',
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'UseAgent - one interface for every coding agent',
    description:
      'Run coding agents in isolated workspaces with durable context, automations, and audit trails.',
  },
};

// `viewportFit: 'cover'` makes iOS report real safe-area insets, so the pinned
// session composer's `pb-[max(1rem,env(safe-area-inset-bottom))]` can clear the
// home indicator (env() resolves to 0 without it).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
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
        <Providers nonce={nonce}>{children}</Providers>
        <RoutePrefetch />
      </body>
    </html>
  );
}
