import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * A shareable payment link is private by design: the short code is the only
 * thing protecting it. It must never be indexed, followed, or cached by a
 * search engine, or the link and its amount/memo would leak into search.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default function PayLayout({ children }: { children: ReactNode }) {
  return children;
}
