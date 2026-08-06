#!/usr/bin/env node
/**
 * Self-host the three webfonts instead of loading them from the Fontshare CDN.
 *
 * Why you'd want this: inside the iOS app a CDN font is a network dependency on the
 * critical render path. globals.css already declares full -apple-system / ui-monospace
 * fallbacks so nothing *breaks* without it, but self-hosting means the app always
 * looks right, including on a cold launch with bad signal.
 *
 * Requires outbound access to api.fontshare.com and its CDN. Run it on a machine with
 * unrestricted network, then commit `public/fonts/` and swap the <link> in
 * src/app/layout.tsx for `@import "/fonts/fonts.css"` in globals.css.
 *
 * Licensing: Satoshi and Clash Grotesk ship under the ITF Free Font Licence and
 * Kode Mono under the SIL OFL — all three permit self-hosting. Nothing here changes
 * that; you are downloading the same files the CDN serves.
 *
 * Usage:  npm run fetch:fonts
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const CSS_URL =
  "https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&f[]=clash-grotesk@500,600,700&f[]=kode-mono@400,500,700&display=swap";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

const outDir = path.resolve("public/fonts");

async function main() {
  console.log("Fetching Fontshare CSS…");
  const res = await fetch(CSS_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Fontshare CSS → HTTP ${res.status}`);
  let css = await res.text();

  const urls = [...new Set([...css.matchAll(/url\((https:\/\/[^)]+?)\)/g)].map((m) => m[1]))];
  if (!urls.length) throw new Error("no font URLs found in the CSS");
  console.log(`Found ${urls.length} font files.`);

  await mkdir(outDir, { recursive: true });

  for (const url of urls) {
    const clean = url.split("?")[0];
    const file = path.basename(clean);
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) {
      console.warn(`  skip ${file} → HTTP ${r.status}`);
      continue;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    await writeFile(path.join(outDir, file), buf);
    css = css.split(url).join(`/fonts/${file}`);
    console.log(`  ${file}  ${(buf.length / 1024).toFixed(0)}KB`);
  }

  await writeFile(path.join(outDir, "fonts.css"), css);
  console.log(`\nWrote ${path.relative(process.cwd(), path.join(outDir, "fonts.css"))}`);
  console.log("\nNext:");
  console.log('  1. In src/app/globals.css add at the very top:  @import "/fonts/fonts.css";');
  console.log("  2. Remove the api.fontshare.com <link> + <link rel=preconnect> from src/app/layout.tsx");
  console.log("  3. npm run build:ios");
}

main().catch((e) => {
  console.error("FAILED:", e.message || e);
  console.error("\nIf this is a network-egress restriction, run it on an unrestricted machine.");
  process.exit(1);
});
