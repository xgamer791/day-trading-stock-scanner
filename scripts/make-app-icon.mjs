/**
 * Generates the source app icon + splash art for `@capacitor/assets`.
 *
 * Everything is drawn from an inline SVG so the repo carries no binary design
 * dependency and the icon can be regenerated on any machine with `npm run ios:icon`.
 * Colours are the app's own design tokens (src/app/globals.css).
 *
 * Outputs:
 *   assets/icon.png            1024×1024  — App Store / home screen
 *   assets/icon-foreground.png 1024×1024  — Android adaptive (harmless on iOS)
 *   assets/icon-background.png 1024×1024
 *   assets/splash.png          2732×2732  — light
 *   assets/splash-dark.png     2732×2732
 *
 * Then run `npm run ios:assets` to expand these into every required size.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const BG = "#0b0d10";
const GREEN = "#16c784";
const GREEN_DIM = "#0f8f5f";

/** Ascending bars + a breakout arrow — a top-gainers board in one glyph. */
function iconSvg(size, { transparent = false } = {}) {
  const s = size;
  const u = s / 1024; // scale factor from the 1024 design grid
  const bars = [
    { x: 212, y: 620, h: 190 },
    { x: 372, y: 520, h: 290 },
    { x: 532, y: 400, h: 410 },
    { x: 692, y: 250, h: 560 },
  ];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#12161d"/>
      <stop offset="100%" stop-color="${BG}"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stop-color="${GREEN_DIM}"/>
      <stop offset="100%" stop-color="${GREEN}"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="18%" r="70%">
      <stop offset="0%" stop-color="${GREEN}" stop-opacity="0.20"/>
      <stop offset="100%" stop-color="${GREEN}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  ${transparent ? "" : `<rect width="${s}" height="${s}" fill="url(#bg)"/>`}
  ${transparent ? "" : `<rect width="${s}" height="${s}" fill="url(#glow)"/>`}

  <g>
    ${bars
      .map(
        (b) =>
          `<rect x="${b.x * u}" y="${b.y * u}" width="${120 * u}" height="${b.h * u}" rx="${22 * u}" fill="url(#bar)" opacity="0.92"/>`,
      )
      .join("\n    ")}
  </g>

  <path d="M ${190 * u} ${560 * u} L ${390 * u} ${430 * u} L ${560 * u} ${520 * u} L ${820 * u} ${215 * u}"
        fill="none" stroke="#ffffff" stroke-width="${46 * u}"
        stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M ${688 * u} ${196 * u} L ${838 * u} ${196 * u} L ${838 * u} ${344 * u}"
        fill="none" stroke="#ffffff" stroke-width="${46 * u}"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

/** Splash: centred mark on flat background, generous quiet zone for any crop. */
function splashSvg(size) {
  const mark = Math.round(size * 0.22);
  const off = Math.round((size - mark) / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${BG}"/>
  <g transform="translate(${off}, ${off})">
    ${iconSvg(mark, { transparent: true }).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}
  </g>
</svg>`;
}

async function png(svg, out, size) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(out);
  console.log(`  ${path.relative(process.cwd(), out)}  ${size}×${size}`);
}

const dir = path.resolve("assets");
await mkdir(dir, { recursive: true });

console.log("Generating app icon + splash source art…");
await png(iconSvg(1024), path.join(dir, "icon.png"), 1024);
await png(iconSvg(1024, { transparent: true }), path.join(dir, "icon-foreground.png"), 1024);
await png(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${BG}"/></svg>`,
  path.join(dir, "icon-background.png"),
  1024,
);
await png(splashSvg(2732), path.join(dir, "splash.png"), 2732);
await png(splashSvg(2732), path.join(dir, "splash-dark.png"), 2732);

console.log("\nDone. Next: npm run ios:assets");
