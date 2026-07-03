import Link from "next/link";
import { Button } from "@/components/ui/button";
import { WebsiteLogo } from "@/components/website-logo";
import {
  WebsiteMobileMenu,
  type WebsiteNavLink,
} from "@/components/website-mobile-menu";
import { CLUB_NAME } from "@/config/club-identity";
import { buildBookingLoginPath } from "@/lib/auth-redirect";
import { listWebsiteMenuPages } from "@/lib/page-content-html";

interface WebsiteHeaderProps {
  isAuthenticated: boolean;
  logoDataUrl?: string | null;
}

const staticNavLinks = [{ href: "/contact", label: "Contact" }];

export async function WebsiteHeader({
  isAuthenticated,
  logoDataUrl,
}: WebsiteHeaderProps) {
  const dynamicPages = await listWebsiteMenuPages();
  const dynamicNavLinks = dynamicPages.map((page) => ({
    href: page.path,
    label: page.menuTitle.trim(),
  }));
  const navLinks: WebsiteNavLink[] = [
    { href: "/", label: "Home" },
    ...dynamicNavLinks,
    ...staticNavLinks,
  ];
  const bookingsHref = isAuthenticated ? "/book" : buildBookingLoginPath();
  const dashboardHref = isAuthenticated ? "/dashboard" : "/login";

  return (
    <header className="sticky top-0 z-50 w-full border-b border-brand-gold/15 bg-brand-charcoal/95 text-brand-snow shadow-[0_16px_40px_-28px_rgba(47,47,43,0.9)] backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Branding */}
        <Link
          href="/"
          className="flex items-center gap-2 font-bold text-brand-snow transition-opacity hover:opacity-85"
        >
          <WebsiteLogo
            label={CLUB_NAME}
            logoDataUrl={logoDataUrl}
            className="max-h-10 max-w-40"
            textClassName="max-w-48 text-brand-snow"
          />
        </Link>

        {/* Desktop nav links */}
        <nav aria-label="Website" className="hidden lg:flex items-center gap-1">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-md px-3 py-2 text-sm font-medium text-brand-snow/80 transition-colors hover:bg-brand-snow/10 hover:text-brand-snow"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Desktop CTA */}
        <div className="hidden lg:flex items-center gap-3">
          {isAuthenticated ? (
            <>
              <Button
                variant="outline"
                size="sm"
                asChild
                className="border-brand-snow/20 bg-brand-snow/5 text-brand-snow hover:bg-brand-snow/10 hover:text-brand-snow"
              >
                <Link href={dashboardHref}>Dashboard</Link>
              </Button>
              <Button
                size="sm"
                asChild
                className="shadow-lg shadow-brand-gold/20"
              >
                <Link href={bookingsHref}>Book Now</Link>
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                asChild
                className="border-brand-snow/20 bg-brand-snow/5 text-brand-snow hover:bg-brand-snow/10 hover:text-brand-snow"
              >
                <Link href="/login">Log In</Link>
              </Button>
              <Button
                size="sm"
                asChild
                className="shadow-lg shadow-brand-gold/20"
              >
                <Link href={bookingsHref}>Book Now</Link>
              </Button>
            </>
          )}
        </div>

        <WebsiteMobileMenu
          isAuthenticated={isAuthenticated}
          clubName={CLUB_NAME}
          logoDataUrl={logoDataUrl}
          navLinks={navLinks}
          bookingsHref={bookingsHref}
          dashboardHref={dashboardHref}
        />
      </div>
    </header>
  );
}
