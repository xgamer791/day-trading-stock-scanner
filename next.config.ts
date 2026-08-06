import type { NextConfig } from "next";

const repo = "day-trading-stock-scanner";

/**
 * Two static-export targets from one codebase:
 *
 *  - GitHub Pages  (`GITHUB_PAGES=true`)  — served from /day-trading-stock-scanner/
 *  - iOS/Capacitor (`CAPACITOR_BUILD=true`) — served from the scheme root by WKWebView,
 *    so a basePath would make every asset 404.
 *
 * CAPACITOR_BUILD wins if both are somehow set.
 */
const isNative = process.env.CAPACITOR_BUILD === "true";
const isGhPages = process.env.GITHUB_PAGES === "true" && !isNative;

const basePath = isGhPages ? `/${repo}` : "";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  basePath,
  assetPrefix: isGhPages ? `${basePath}/` : undefined,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_CAPACITOR_BUILD: isNative ? "true" : "",
  },
};

export default nextConfig;
