import type { Metadata } from 'next';
import { Inter, JetBrains_Mono, Source_Serif_4 } from 'next/font/google';
import Providers from '@/app/providers';
import '@/app/globals.css';

export const metadata: Metadata = {
  title: 'WordBrain',
  description: 'Local-first English vocabulary builder with word-network graphs and FSRS review',
};

// next/font self-hosts the WOFF2 files at build time, so the editorial faces
// keep working when the Tauri shell is offline.
const serif = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-serif',
  weight: ['300', '400', '500', '600', '700'],
  style: ['normal', 'italic'],
  display: 'swap',
});
const sans = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});
const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400', '500'],
  display: 'swap',
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${serif.variable} ${sans.variable} ${mono.variable}`}
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
