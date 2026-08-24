import type { Metadata } from "next";
import { Inter, Plus_Jakarta_Sans, Cormorant_Garamond } from "next/font/google";
import { Providers } from "./providers";
import { themeScript } from "@hamza/shared/theme/ThemeProvider";
import "./globals.css";

// The admin app runs as a standard Next.js Node server (`next start`, e.g. on
// Railway). Routes use the default Node.js runtime — no edge runtime is forced.

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-heading",
  weight: ["500", "600", "700", "800"],
});

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body",
});

// Editorial serif for the customer storefront (display headings + wordmark).
const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-serif",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: {
    default: "Hamza General Store — Admin",
    template: "%s · Hamza General Store",
  },
  description: "Inventory management & point-of-sale for Hamza General Store.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body
        className={`${jakarta.variable} ${inter.variable} ${cormorant.variable}`}
        suppressHydrationWarning
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
