import type { Metadata, Viewport } from "next";
import "./globals.css";
import { TopBar } from "@/components/TopBar";

export const metadata: Metadata = {
  title: { default: "Matchframe2D Replayer", template: "%s · Matchframe2D Replayer" },
  description: "Review CS2 demos on a 2D radar: rounds, utility, bookmarks, notes, playlists and voice comms.",
  metadataBase: new URL(process.env.APP_ORIGIN ?? "https://2d.matchframe.tv"),
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#0f141b", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TopBar />
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
