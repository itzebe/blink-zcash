import type { Metadata, Viewport } from 'next';
import './globals.css';
import { NetworkGuard } from '@/components/NetworkGuard';

export const metadata: Metadata = {
  title: 'BLINK — Send money, not your wallet address',
  description:
    'BLINK is a radically simple private-payment interface for Zcash. Create a payment request, share a link, get paid.',
  applicationName: 'BLINK',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#07080a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <NetworkGuard>{children}</NetworkGuard>
      </body>
    </html>
  );
}
