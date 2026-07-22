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
  URGENT: "bg-danger-3 border-danger-6 text-danger-11",
  WARNING: "bg-warning-3 border-warning-6 text-warning-11",
  NOTIFY: "bg-info-3 border-info-6 text-info-11",
};
