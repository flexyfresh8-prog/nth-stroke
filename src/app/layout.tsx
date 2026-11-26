import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ThemeProvider } from "next-themes";

export const metadata: Metadata = {
  title: "NTH Stroke — Autonomous Drawing Engine",
  description:
    "An autonomous computational artist that observes a reference, constructs, shades, evaluates and corrects a graphite drawing stroke by stroke — entirely in your browser.",
  keywords: ["drawing engine", "computational art", "graphite", "pencil", "autonomous", "generative art"],
  authors: [{ name: "NTH Stroke" }],
  icons: { icon: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/nth-stroke.svg` },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="nth-studio antialiased"><ThemeProvider attribute="class" defaultTheme="dark" enableSystem>{children}</ThemeProvider></body>
    </html>
  );
}
