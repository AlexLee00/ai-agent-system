'use strict';
const withPWA = require('@ducanh2912/next-pwa').default({
  dest: 'public',
  register: false,
  skipWaiting: true,
  disable: true,
  workboxOptions: { disableDevLogs: true },
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // API proxy → Express on port 4000
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.WORKER_API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:4000'}/api/:path*`,
      },
    ];
  },
};

module.exports = withPWA(nextConfig);
