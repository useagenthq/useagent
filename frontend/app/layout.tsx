import type { Metadata } from 'next';
import { Inter, Inter_Tight, JetBrains_Mono } from 'next/font/google';

import { cn } from '@/utils/cn';
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
  title: 'useAgent - Loop agent platform',
  description: 'Internal agent platform for Loop, built on AlignUI + prompt-kit.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang='en'
      suppressHydrationWarning
      className={cn(
        fontSans.className,
        fontSans.variable,
        fontMono.variable,
        fontDisplay.variable,
        'antialiased'
      )}
    >
      <body className='bg-bg-white-0 text-text-strong-950'>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
