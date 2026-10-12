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

const defaultAppUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.useagent.org';

/** Resolves the actual public origin at request time so og:image URLs point
 *  to the real host — works for localhost, localtunnel, and production. */
async function resolveBase(): Promise<URL> {
  try {
    const h = await headers();
    const proto = h.get('x-forwarded-proto') ?? 'https';
    const host = h.get('x-forwarded-host') ?? h.get('host');
    if (host) return new URL(`${proto}://${host}`);
  } catch {
    // headers() throws outside a request context (e.g. static generation)
  }
  return new URL(defaultAppUrl);
}

export async function generateMetadata(): Promise<Metadata> {
  const base = await resolveBase();
  const appUrl = base.origin;
  return {
    metadataBase: base,
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
      images: [
        {
          url: `${appUrl}/opengraph-image`,
          width: 1600,
          height: 900,
          alt: 'UseAgent - one interface for every coding agent',
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: 'UseAgent - one interface for every coding agent',
      description:
        'Run coding agents in isolated workspaces with durable context, automations, and audit trails.',
      images: [`${appUrl}/opengraph-image`],
    },
  };
}

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
