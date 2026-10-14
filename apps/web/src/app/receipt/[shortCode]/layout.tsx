import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * A receipt is reached by the same private short code as the payment link and
 * carries the amount, memo and txid. It must never be indexed or cached.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default function ReceiptLayout({ children }: { children: ReactNode }) {
  return children;
}
