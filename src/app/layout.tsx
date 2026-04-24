import type { Metadata } from 'next';
import Providers from '@/app/providers';
import '@/app/globals.css';

export const metadata: Metadata = {
  title: 'WordBrain',
  description: 'Local-first English vocabulary builder with word-network graphs and FSRS review',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
