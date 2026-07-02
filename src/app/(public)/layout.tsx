import { auth } from "@/lib/auth";
import { Inter, League_Spartan } from "next/font/google";
import { headers } from "next/headers";
import { AppProviders } from "@/components/app-providers";
import { SiteBanners } from "@/components/site-banners";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { WebsiteHeader } from "@/components/website-header";
import { WebsiteFooter } from "@/components/website-footer";
import { clubIdentity } from "@/config/club-identity";
import { CSP_NONCE_HEADER } from "@/lib/csp";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { getCurrentSiteBanners } from "@/lib/site-banners";

const websiteBodyFont = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-website-body",
});

const websiteHeadingFont = League_Spartan({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-website-heading",
});

export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [session, lodgeCapacity, siteBanners] = await Promise.all([
    auth(),
    getLodgeCapacity(),
    getCurrentSiteBanners(),
  ]);
  const liveClubIdentity = { ...clubIdentity, lodgeCapacity };
  const requestHeaders = await headers();
  const nonce = requestHeaders.get(CSP_NONCE_HEADER) ?? undefined;
  const pageSlug = requestHeaders.get("x-page-slug") ?? "home";

  return (
    <AppProviders clubIdentity={liveClubIdentity} nonce={nonce}>
      <div
        className={`${websiteBodyFont.variable} ${websiteHeadingFont.variable} app-theme-scope min-h-screen flex flex-col bg-background text-foreground`}
      >
        <SiteBanners banners={siteBanners} />
        <WebsiteHeader isAuthenticated={!!session?.user} />
        <main className="flex-1">
          <div className="mx-auto flex w-full max-w-7xl justify-end px-4 pt-4 sm:px-6 lg:px-8">
            <ThemeSwitcher className="w-full max-w-sm" />
          </div>
          <div className="flex min-h-[calc(100vh-18rem)] items-center justify-center p-4">
            {children}
          </div>
        </main>
        <WebsiteFooter pageSlug={pageSlug} />
      </div>
    </AppProviders>
  );
}
