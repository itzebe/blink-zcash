import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  eslint: {
    ignoreDuringBuilds: true,
  },

  transpilePackages: [
    '@blink/shared',
    '@blink/zcash',
    '@blink/payment-request',
  ],

  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': path.resolve(__dirname, 'src'),
    };

    return config;
  },

  async rewrites() {
    const apiUrl =
      process.env.NEXT_PUBLIC_API_BASE_URL ||
      process.env.API_BASE_URL ||
      'http://localhost:4000';
    return [
      {
        source: '/v1/:path*',
        destination: `${apiUrl.replace(/\/$/, '')}/v1/:path*`,
      },
    ];
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            // Camera is allowed for same-origin so the /scan page can open the
            // QR scanner; microphone and geolocation stay disabled.
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
  
