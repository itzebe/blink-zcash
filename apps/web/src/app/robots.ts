import type { MetadataRoute } from 'next';

const SITE_URL = process.env.APP_BASE_URL || 'https://blink-web-bgkz.onrender.com';

/**
 * Marketing pages are meant to be found. Shareable payment links, receipts, and
 * the per-device merchant workspace are not: a link's only protection is the
 * secret short code, and the workspace is personal to one browser.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/pay/', '/receipt/', '/merchant/'] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
