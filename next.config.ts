import type { NextConfig } from 'next';

// Keep browser requests same-origin on the frontend PC; only the Next server
// contacts the tailnet backend, including streaming events and evidence files.
const backendOrigin = process.env.SIGHTLINE_BACKEND_ORIGIN;
if (backendOrigin) {
  const target = new URL(backendOrigin);
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.pathname !== '/' ||
    target.search ||
    target.hash
  )
    throw new Error(
      'SIGHTLINE_BACKEND_ORIGIN must be an HTTP(S) origin without credentials or a path',
    );
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  turbopack: { root: process.cwd() },
  rewrites() {
    if (!backendOrigin) return [];
    return ['/api/:path*', '/artifacts/:path*', '/report/:path*'].map((source) => ({
      source,
      destination: `${new URL(backendOrigin).origin}${source}`,
    }));
  },
  headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;
