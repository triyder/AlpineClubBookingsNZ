"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { WebsiteNavLink } from "@/components/website-mobile-menu";

// Desktop primary navigation. Client component so the active-page highlight
// tracks client-side navigation (the header lives in the persistent (website)
// layout, whose server render does not re-run on in-app navigation).
export function WebsiteNavLinks({
  navLinks,
}: {
  navLinks: ReadonlyArray<WebsiteNavLink>;
}) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href;

  return (
    <nav aria-label="Website" className="hidden lg:flex items-center gap-1">
      {navLinks.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          aria-current={isActive(link.href) ? "page" : undefined}
          className="rounded-md px-3 py-2 text-sm font-medium text-brand-snow/80 transition-colors hover:bg-brand-snow/10 hover:text-brand-snow aria-[current=page]:bg-brand-snow/15 aria-[current=page]:font-semibold aria-[current=page]:text-brand-snow"
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
