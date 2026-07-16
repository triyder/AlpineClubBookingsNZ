import type { Metadata } from "next";
import { CLUB_PUBLIC_URL } from "@/config/club-identity";
import { getClubIdentity } from "@/lib/club-identity-settings";
import "./globals.css";

const baseUrl = process.env.NEXTAUTH_URL || CLUB_PUBLIC_URL;

// DB-first, club-generic site metadata (E3 #1929): title/description build from
// the admin-editable club name and the default lodge's name — no hardcoded
// geography ("Mt Ruapehu", "Whakapapa", "Est. 1969" were removed so any club
// reads correctly).
export async function generateMetadata(): Promise<Metadata> {
  const { name, lodgeName } = await getClubIdentity();
  const title = `${name} — ${lodgeName}`;
  const description = `${name} — book a stay at ${lodgeName}, join the club, and explore New Zealand's mountains.`;
  return {
    title: {
      template: `%s | ${name}`,
      default: title,
    },
    description,
    metadataBase: new URL(baseUrl),
    icons: {
      icon: "/branding/favicon.ico",
      shortcut: "/branding/favicon.ico",
    },
    openGraph: {
      title,
      description,
      url: baseUrl,
      siteName: name,
      images: [
        {
          url: "/branding/og-image.png",
          width: 1200,
          height: 630,
          alt: `${name} Logo`,
        },
      ],
      locale: "en_NZ",
      type: "website",
    },
  };
}

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
