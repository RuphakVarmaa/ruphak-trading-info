import type { Metadata } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";
import "./globals.css";

// Variable fonts: every weight in one file each.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

// Headings: a quiet book serif with optical sizes, so large titles stay crisp.
const serif = Source_Serif_4({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--font-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Ruphak Trading Info — India Index Desk",
  description:
    "NIFTY and SENSEX weekly options traded on paper from the news and market signals, with every check explained, alongside metals and macro news. Paper simulation, not investment advice. Maintained by Ruphak.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${serif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
