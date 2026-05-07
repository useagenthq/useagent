import type { Metadata } from 'next';
import { Inter, JetBrains_Mono, Newsreader } from 'next/font/google';

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

// Editorial display serif (Tiempos/Signifier class). Variable font with the
// optical-size axis so display sizes (28–40px) render with delicate, high-
// contrast strokes while text sizes stay legible on the dark #17181a canvas.
const fontDisplay = Newsreader({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
  axes: ['opsz'],
});

export const metadata: Metadata = {
  title: 'skynet-a - Loop agent platform',
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
