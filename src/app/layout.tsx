import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Top Gainers — Day Trading Stock Screener",
  description:
    "Real-time top gainers across the entire US market: breaking news, premarket movers, and market top % gainers.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&f[]=clash-grotesk@500,600,700&f[]=kode-mono@400,500,700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
