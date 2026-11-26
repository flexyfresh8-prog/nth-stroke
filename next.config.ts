import type { NextConfig } from "next";

/**
 * NTH Stroke — Next.js configuration.
 *
 * Two build modes:
 *  - development / server: `next dev` (no changes needed)
 *  - static export (GitHub Pages): `EXPORT=1 BASE_PATH=/nth-stroke npm run build:export`
 *    emits a fully static site into ./out — the engine, worker and models
 *    all run client-side, so no server is required.
 */
const isExport = process.env.EXPORT === "1";

const nextConfig: NextConfig = {
  // DIST_DIR lets verification builds run beside the dev server's .next.
  distDir: process.env.DIST_DIR ?? ".next",
  env: { NEXT_PUBLIC_BASE_PATH: isExport ? process.env.BASE_PATH ?? "/nth-stroke" : "" },
  ...(isExport
    ? {
        output: "export" as const,
        basePath: process.env.BASE_PATH ?? "/nth-stroke",
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : { output: "standalone" as const }),
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
};

export default nextConfig;
