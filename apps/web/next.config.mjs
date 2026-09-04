/** @type {import('next').NextConfig} */
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';
const { hostname, port, protocol } = new URL(apiUrl);
const staticExport = process.env.STATIC_EXPORT === 'true';

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false, // don't advertise the framework in response headers
  // Render can serve this fully client-driven frontend as a free static site.
  // Keep the normal Next.js server build everywhere else (including Docker).
  ...(staticExport ? { output: 'export', trailingSlash: true } : {}),
  eslint: { ignoreDuringBuilds: true },
  images: {
    // Next's image optimizer needs a Node server, which a static export does not
    // have. Browser-native image loading is sufficient for the uploaded photos.
    unoptimized: staticExport,
    remotePatterns: [
      {
        protocol: protocol.replace(':', ''),
        hostname,
        port: port || undefined,
        pathname: '/uploads/**',
      },
    ],
  },
};

export default nextConfig;
