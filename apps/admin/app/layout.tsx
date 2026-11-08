import type { ReactNode } from 'react';
import { ApiProvider } from '@/lib/api';
import './globals.css';

export const metadata = { title: 'Agently admin', robots: { index: false, follow: false } };

// Read API_URL on each request, so the same image runs on any domain.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  const apiUrl = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body>
        <ApiProvider apiUrl={apiUrl}>{children}</ApiProvider>
      </body>
    </html>
  );
}
