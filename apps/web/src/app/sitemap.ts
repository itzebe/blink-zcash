import type { MetadataRoute } from 'next';

const SITE_URL = process.env.APP_BASE_URL || 'https://blink-web-bgkz.onrender.com';

/** Only the public, indexable pages. Payment links and receipts are excluded. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: 'monthly', priority: 1 },
    { url: `${SITE_URL}/litepaper`, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${SITE_URL}/request`, changeFrequency: 'monthly', priority: 0.6 },
  ];
}
