import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NTH Stroke — Autonomous Drawing Engine",
  description:
    "An autonomous computational artist that observes a reference, constructs, shades, evaluates and corrects a graphite drawing stroke by stroke — entirely in your browser.",
  keywords: ["drawing engine", "computational art", "graphite", "pencil", "autonomous", "generative art"],
  authors: [{ name: "NTH Stroke" }],
  icons: { icon: "/nth-stroke.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="nth-studio antialiased">{children}</body>
    </html>
  );
}
