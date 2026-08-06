import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Top Gainers — Day Trading Stock Screener",
  description:
    "Real-time top gainers across the entire US market: breaking news, premarket movers, and market top % gainers.",
  applicationName: "Top Gainers",
  appleWebApp: {
    capable: true,
    title: "Top Gainers",
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    telephone: false,
  },
};

/**
 * `viewportFit: "cover"` lets the layout paint under the notch / home indicator so
 * the sticky header and bottom tab bar can own their safe-area insets via
 * `env(safe-area-inset-*)` in globals.css.
 *
 * Zoom is disabled deliberately: this is a dense numeric table that must not
 * pinch-zoom or double-tap-zoom out from under the user mid-scan.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0b0d10",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        {/*
          Fonts are CDN-hosted. globals.css declares full local fallback stacks
          (-apple-system / ui-monospace) so the app is never unstyled if this is
          slow or unreachable. Run `npm run fetch:fonts` to self-host them.
        */}
        <link rel="preconnect" href="https://api.fontshare.com" crossOrigin="" />
        <link
          href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&f[]=clash-grotesk@500,600,700&f[]=kode-mono@400,500,700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
