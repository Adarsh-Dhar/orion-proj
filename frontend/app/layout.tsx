import type { Metadata } from "next";
import { Geist, Geist_Mono, Big_Shoulders } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const bigShoulders = Big_Shoulders({
  variable: "--font-display",
  weight: ["700", "900"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Orion — hunts rugs on Base",
  description:
    "Orion reads every new Uniswap V3 and V4 pool on Base the moment it's created, pulls on-chain evidence, and posts a risk verdict before the pool has its first real trade.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${bigShoulders.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-[#0B0C0E]">{children}</body>
    </html>
  );
}
