import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ConnectionProvider, ConnectionGate } from '@/components/ConnectionProvider';

/**
 * The public URL of the deployed application. Used to resolve Open Graph and
 * canonical URLs. Overridable with APP_BASE_URL at build time.
 */
const SITE_URL = process.env.APP_BASE_URL || 'https://blink-web-bgkz.onrender.com';

const DESCRIPTION =
  'BLINK helps you create and share Zcash payment requests, with a shielded-first approach to privacy and transaction verification. Non-custodial and built on ZIP 321.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'BLINK — Private Zcash payment requests',
    template: '%s · BLINK',
  },
  description: DESCRIPTION,
  applicationName: 'BLINK',
  keywords: [
    'Zcash',
    'shielded payments',
    'ZIP 321',
    'payment request',
    'privacy',
    'cryptocurrency',
  ],
  alternates: { canonical: '/' },
  // The marketing pages (home, litepaper) are meant to be found; there is no
  // private account area to keep out of search.
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    siteName: 'BLINK',
    title: 'BLINK — Private Zcash payment requests',
    description: DESCRIPTION,
    url: '/',
  },
  twitter: {
    card: 'summary',
    title: 'BLINK — Private Zcash payment requests',
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b1b33',
};


export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ConnectionProvider>
          <ConnectionGate>{children}</ConnectionGate>
        </ConnectionProvider>
      </body>
    </html>
  );
}
