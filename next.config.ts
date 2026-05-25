import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    // Skip type checking during build — run `tsc --noEmit` separately in CI
    ignoreBuildErrors: true,
  },
  // Server-only packages that should be loaded via Node require() at runtime
  // instead of bundled by webpack. pdf-parse depends on pdfjs-dist which
  // references browser globals (DOMMatrix, Path2D, ImageData); bundling it
  // loses our polyfill ordering. Listing it here makes Next.js require() it
  // at runtime so the polyfill applied in the route module is in effect when
  // pdfjs-dist initializes.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
  experimental: {
    // Enable server actions
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },

  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.huntlogic.com",
      },
      {
        // Google profile images
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
      {
        // Apple profile images
        protocol: "https",
        hostname: "appleid.cdn-apple.com",
      },
    ],
  },

  // PWA support — enable when @ducanh2912/next-pwa is installed
  // const withPWA = require("@ducanh2912/next-pwa")({
  //   dest: "public",
  //   disable: process.env.NODE_ENV === "development",
  //   register: true,
  //   skipWaiting: true,
  // });
  // module.exports = withPWA(nextConfig);

  // Redirect API v1 health to top-level health
  async redirects() {
    return [];
  },

  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
        ],
      },
    ];
  },
};

export default nextConfig;
