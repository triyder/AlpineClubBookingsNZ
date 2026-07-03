// Shared site-banner constants usable from both server and client code.
// Keep this module free of server-only imports: the public banner component
// and the admin panel preview both render from these definitions.

export const SITE_BANNER_PRIORITIES = ["URGENT", "WARNING", "NOTIFY"] as const;

export type SiteBannerPriorityValue = (typeof SITE_BANNER_PRIORITIES)[number];

export const SITE_BANNER_MESSAGE_MAX_LENGTH = 500;

export const SITE_BANNER_PRIORITY_LABELS: Record<
  SiteBannerPriorityValue,
  string
> = {
  URGENT: "Urgent",
  WARNING: "Warning",
  NOTIFY: "Notify",
};

// Faded background palette per priority (issue #994): red / amber / blue.
export const SITE_BANNER_PRIORITY_CLASSES: Record<
  SiteBannerPriorityValue,
  string
> = {
  URGENT: "bg-red-100 border-red-300 text-red-900",
  WARNING: "bg-amber-100 border-amber-300 text-amber-900",
  NOTIFY: "bg-blue-100 border-blue-300 text-blue-900",
};
