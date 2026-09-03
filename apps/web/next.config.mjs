/** @type {import('next').NextConfig} */
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';
const { hostname, port, protocol } = new URL(apiUrl);

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false, // don't advertise the framework in response headers
  eslint: { ignoreDuringBuilds: true },
  images: {
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
