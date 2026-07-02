import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });

export const metadata: Metadata = {
  title: "ConTxt — AI replies without switching apps",
  description:
    "ConTxt reads your incoming messages and surfaces the perfect reply right where you are. No copy-paste, no context switching.",
  openGraph: {
    title: "ConTxt — AI replies without switching apps",
    description:
      "Smart replies powered by your calendar, location, and context. Android first.",
    url: "https://get-contxt.app",
    siteName: "ConTxt",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "ConTxt — AI replies without switching apps",
    description: "Smart replies powered by your calendar, location, and context.",
  },
  metadataBase: new URL("https://get-contxt.app"),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={geist.variable}>
      <body className="antialiased bg-white text-zinc-900">{children}</body>
    </html>
  );
}
