import type { Metadata } from "next";
import {
  CLUB_NAME,
  CLUB_PUBLIC_URL,
  clubIdentity,
} from "@/config/club-identity";
import "./globals.css";

const baseUrl = process.env.NEXTAUTH_URL || CLUB_PUBLIC_URL;

export const metadata: Metadata = {
  title: {
    template: `%s | ${CLUB_NAME}`,
    default: `${CLUB_NAME} — Mt Ruapehu Lodge`,
  },
  description: `${CLUB_NAME} — ${clubIdentity.lodgeCapacity}-bed lodge on Mt Ruapehu, Whakapapa. Book a stay, join the club, and explore New Zealand's mountains. Est. 1969.`,
  metadataBase: new URL(baseUrl),
  icons: {
    icon: "/branding/favicon.ico",
    shortcut: "/branding/favicon.ico",
  },
  openGraph: {
    title: `${CLUB_NAME} — Mt Ruapehu Lodge`,
    description: `${clubIdentity.lodgeCapacity}-bed lodge in the Whakapapa ski area. Book a stay, join the club, and explore New Zealand's mountains. Est. 1969.`,
    url: baseUrl,
    siteName: CLUB_NAME,
    images: [
      {
        url: "/branding/og-image.png",
        width: 1200,
        height: 630,
        alt: `${CLUB_NAME} Logo`,
      },
    ],
    locale: "en_NZ",
    type: "website",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body
        className="min-h-full flex flex-col font-sans"
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
