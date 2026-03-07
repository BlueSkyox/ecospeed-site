import type { Metadata } from "next";
import "./globals.css";
import "./ecospeed-clone.css";

export const metadata: Metadata = {
  title: "ECOSPEED - EV Eco-Speed Optimizer",
  description: "EV Eco-Speed Optimizer - Green Driving Optimizer for Electric Vehicles",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/logo-ecospeed.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <meta name="theme-color" content="#000000" />
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
