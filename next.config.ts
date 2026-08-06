import { execSync } from "node:child_process";
import type { NextConfig } from "next";

const repo = "day-trading-stock-scanner";

/**
 * Commit the bundle was built from.
 *
 * A timestamp alone only proves *when* you built — building stale code still
 * produces a fresh stamp. The short SHA is what actually answers "is the phone
 * running the latest commit", which cost us several debugging rounds. `-dirty`
 * marks uncommitted local edits.
 */
function gitStamp(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const dirty = execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
      ? "-dirty"
      : "";
    return `${sha}${dirty}`;
  } catch {
    return "nogit";
  }
}

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
    // Stamped at build time and shown in the drawer + Connection screen, so
    // "which build is this phone actually running" is answerable at a glance.
    // Commit first — that is the part that proves the code is current.
    NEXT_PUBLIC_BUILD_STAMP:
      gitStamp() + " · " + new Date().toISOString().slice(0, 16).replace("T", " ") + "Z",
  },
};

export default nextConfig;
