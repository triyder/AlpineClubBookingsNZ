import "server-only";

import { buildBookingLoginPath } from "@/lib/auth-redirect";
import { DEFAULT_PUBLIC_CONTENT_SETTINGS } from "@/config/club-settings-defaults";
import { prisma } from "@/lib/prisma";

/**
 * Resolved public "Book Now" button state (E3 #1929).
 *  - `show: false` — the admin hid the button; render nothing.
 *  - `show: true` — render the button pointing at `href`.
 *
 * FAIL-OPEN contract: anything other than a hidden button or a PAGE target that
 * resolves to a PUBLISHED page (missing FK, unpublished page, DB error) falls
 * back to the default booking flow, so the button is never dead.
 */
export interface BookNowConfig {
  show: boolean;
  href: string;
}

export async function getBookNowConfig(
  isAuthenticated: boolean,
): Promise<BookNowConfig> {
  // Default flow: a logged-in member books directly; a guest goes via login.
  const defaultHref = isAuthenticated ? "/book" : buildBookingLoginPath();

  try {
    const settings = await prisma.publicContentSettings.findUnique({
      where: { id: "default" },
      select: {
        showBookNow: true,
        bookNowTarget: true,
        bookNowPage: { select: { path: true, published: true } },
      },
    });

    // No row yet: preserve the historical shown-and-points-at-booking-flow. The
    // shown default is the same portable value config transfer exports for an
    // unsaved singleton (#2200), sourced from one constant so the two cannot drift.
    if (!settings)
      return { show: DEFAULT_PUBLIC_CONTENT_SETTINGS.showBookNow, href: defaultHref };

    if (!settings.showBookNow) return { show: false, href: defaultHref };

    if (
      settings.bookNowTarget === "PAGE" &&
      settings.bookNowPage?.published &&
      settings.bookNowPage.path
    ) {
      return { show: true, href: settings.bookNowPage.path };
    }

    // BOOKING_FLOW, or a PAGE target whose page is missing/unpublished: fail open.
    return { show: true, href: defaultHref };
  } catch {
    return { show: true, href: defaultHref };
  }
}
