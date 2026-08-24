/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Lets a production build live somewhere other than .next, so `next start`
  // can be served alongside a running `next dev` (which owns .next) during
  // local testing. Unset — the normal case, including deploys — it is exactly
  // the previous behaviour.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Shared workspace package consumed as TS source.
  transpilePackages: ["@hamza/shared"],
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "qdftxmdxernjzwipqyrq.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
  experimental: {
    // Cache the RSC payload of dynamic pages so tab-switching is instant.
    staleTimes: { dynamic: 120, static: 300 },
    optimizePackageImports: ["lucide-react", "date-fns", "recharts"],
    // Product/variant photo uploads go through server actions as multipart data.
    serverActions: { bodySizeLimit: "10mb" },
  },
};

export default nextConfig;
