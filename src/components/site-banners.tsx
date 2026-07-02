"use client";

import { useEffect, useState } from "react";
import { Info, TriangleAlert, X } from "lucide-react";
import {
  SITE_BANNER_PRIORITY_CLASSES,
  type SiteBannerPriorityValue,
} from "@/lib/site-banner-shared";

export type SiteBannerItem = {
  id: string;
  message: string;
  priority: SiteBannerPriorityValue;
  /** ISO timestamp of the banner's last edit; invalidates stale dismissals. */
  updatedAt: string;
};

// Single localStorage key mapping banner id -> dismissal timestamp (ISO).
const DISMISSED_STORAGE_KEY = "site-banners.dismissed.v1";

type DismissalMap = Record<string, string>;

// Read the dismissal map defensively: corrupt or foreign values are ignored.
function readDismissals(): DismissalMap {
  try {
    const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const map: DismissalMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        map[key] = value;
      }
    }
    return map;
  } catch {
    return {};
  }
}

function writeDismissals(map: DismissalMap) {
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Private browsing / quota errors: dismissal still applies for this render.
  }
}

// A banner stays dismissed only while its last edit predates the dismissal;
// editing a banner re-shows it to everyone who dismissed the older wording.
function isDismissed(banner: SiteBannerItem, dismissals: DismissalMap): boolean {
  const dismissedAt = dismissals[banner.id];
  if (!dismissedAt) {
    return false;
  }
  const dismissedTime = Date.parse(dismissedAt);
  const updatedTime = Date.parse(banner.updatedAt);
  if (Number.isNaN(dismissedTime) || Number.isNaN(updatedTime)) {
    return false;
  }
  return updatedTime <= dismissedTime;
}

/**
 * Site-wide notification banners stacked above the site header.
 *
 * The server renders every current banner so no-JS visitors always see
 * notices; a mount effect then hides banners this browser has dismissed
 * (an accepted brief flash for returning visitors).
 */
export function SiteBanners({ banners }: { banners: SiteBannerItem[] }) {
  // null = dismissals not read yet (server render / pre-hydration).
  const [dismissals, setDismissals] = useState<DismissalMap | null>(null);

  useEffect(() => {
    setDismissals(readDismissals());
  }, []);

  if (banners.length === 0) {
    return null;
  }

  const visibleBanners =
    dismissals === null
      ? banners
      : banners.filter((banner) => !isDismissed(banner, dismissals));

  if (visibleBanners.length === 0) {
    return null;
  }

  function dismiss(banner: SiteBannerItem) {
    const next: DismissalMap = {
      ...(dismissals ?? readDismissals()),
      [banner.id]: new Date().toISOString(),
    };
    setDismissals(next);
    writeDismissals(next);
  }

  return (
    <div data-testid="site-banners">
      {visibleBanners.map((banner) => {
        const PriorityIcon = banner.priority === "NOTIFY" ? Info : TriangleAlert;
        return (
          <div
            key={banner.id}
            role={banner.priority === "URGENT" ? "alert" : "status"}
            className={`w-full border-b ${SITE_BANNER_PRIORITY_CLASSES[banner.priority]}`}
          >
            <div className="mx-auto flex w-full max-w-7xl items-start gap-3 px-4 py-3 sm:px-6 lg:px-8">
              <PriorityIcon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
              {/* Message is plain text; React escaping means no HTML surface. */}
              <p className="flex-1 self-center whitespace-pre-line text-sm font-medium">
                {banner.message}
              </p>
              <button
                type="button"
                aria-label="Dismiss notice"
                onClick={() => dismiss(banner)}
                className="-my-2 -mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-black/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-current"
              >
                <X aria-hidden="true" className="h-5 w-5" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
