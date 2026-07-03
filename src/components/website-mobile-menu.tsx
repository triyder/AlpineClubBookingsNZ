"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WebsiteLogo } from "@/components/website-logo";

export interface WebsiteNavLink {
  href: string;
  label: string;
}

interface WebsiteMobileMenuProps {
  isAuthenticated: boolean;
  clubName: string;
  logoDataUrl?: string | null;
  navLinks: ReadonlyArray<WebsiteNavLink>;
  bookingsHref: string;
  dashboardHref: string;
}

export function WebsiteMobileMenu({
  isAuthenticated,
  clubName,
  logoDataUrl,
  navLinks,
  bookingsHref,
  dashboardHref,
}: WebsiteMobileMenuProps) {
  const pathname = usePathname();
  const detailsRef = useRef<HTMLDetailsElement>(null);

  const closeMenu = useCallback(() => {
    if (detailsRef.current) {
      detailsRef.current.open = false;
    }
  }, []);

  useEffect(() => {
    closeMenu();
  }, [closeMenu, pathname]);

  return (
    <details ref={detailsRef} className="group relative lg:hidden">
      <summary
        aria-label="Open menu"
        className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-md text-brand-snow transition-colors hover:bg-brand-snow/10 hover:text-brand-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold [&::-webkit-details-marker]:hidden"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </summary>
      <div className="website-mobile-menu absolute right-0 top-12 w-72 rounded-md border border-brand-ridge/25 bg-brand-charcoal p-5 text-brand-snow shadow-2xl">
        <div className="mb-5">
          <WebsiteLogo
            label={clubName}
            logoDataUrl={logoDataUrl}
            className="max-h-8 max-w-36"
            textClassName="text-brand-snow"
          />
        </div>
        <nav aria-label="Website menu" className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={closeMenu}
              className="rounded-md px-3 py-2.5 text-sm font-medium text-brand-snow/85 transition-colors hover:bg-brand-snow/10 hover:text-brand-snow"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="mt-6 flex flex-col gap-2 border-t border-brand-snow/10 px-3 pt-6">
          {isAuthenticated ? (
            <>
              <Button
                variant="outline"
                size="sm"
                asChild
                className="w-full border-brand-snow/20 bg-brand-snow/5 text-brand-snow hover:bg-brand-snow/10 hover:text-brand-snow"
              >
                <Link href={dashboardHref} onClick={closeMenu}>
                  Dashboard
                </Link>
              </Button>
              <Button
                size="sm"
                asChild
                className="w-full shadow-lg shadow-brand-gold/20"
              >
                <Link href={bookingsHref} onClick={closeMenu}>
                  Book Now
                </Link>
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                asChild
                className="w-full border-brand-snow/20 bg-brand-snow/5 text-brand-snow hover:bg-brand-snow/10 hover:text-brand-snow"
              >
                <Link href="/login" onClick={closeMenu}>
                  Log In
                </Link>
              </Button>
              <Button
                size="sm"
                asChild
                className="w-full shadow-lg shadow-brand-gold/20"
              >
                <Link href={bookingsHref} onClick={closeMenu}>
                  Book Now
                </Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </details>
  );
}
