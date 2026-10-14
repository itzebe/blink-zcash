import type { MetadataRoute } from 'next';

const SITE_URL = process.env.APP_BASE_URL || 'https://blink-web-bgkz.onrender.com';

/**
 * Marketing pages are meant to be found. Shareable payment links and receipts
 * are not: their only protection is the secret short code.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/pay/', '/receipt/'] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
