export type EditablePageRecord = {
  id: string;
  slug: string;
  caption: string;
  menuTitle: string;
  title: string;
  headerText: string;
  path: string;
  sortOrder: number;
  contentHtml: string;
  updatedAt: string | null;
  updatedByMemberId: string | null;
};

export const PAGE_SLUG_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

const RESERVED_PAGE_SLUGS = new Set([
  "admin",
  "api",
  "book",
  "dashboard",
  "login",
  "logout",
  "register",
  "forgot-password",
  "reset-password",
  // Static website routes that take precedence over the [slug] catch-all
  // "committee",
  // "contact",
  "faq",
  "privacy",
  // "rules",
  "terms",
]);

export function normalizePageSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
}

export function isValidPageSlug(value: string): boolean {
  return PAGE_SLUG_PATTERN.test(value);
}

export function isReservedPageSlug(value: string): boolean {
  return RESERVED_PAGE_SLUGS.has(value);
}

export function toPagePath(slug: string): string {
  return `/${slug}`;
}
