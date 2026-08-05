import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HOD Scanner — Day Trading Stock Screener",
  description:
    "Real-time high-of-day stock scanner: breaking news, premarket HOD gainers, and market top gainers.",
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
