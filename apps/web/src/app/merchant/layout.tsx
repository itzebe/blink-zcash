import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * The merchant workspace lists the payment requests this browser created. It is
 * personal to one device and should not be indexed or cached by a search engine.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default function MerchantLayout({ children }: { children: ReactNode }) {
  return children;
}
