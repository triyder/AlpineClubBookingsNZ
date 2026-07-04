import Link from "next/link";
import { WebsiteLogo } from "@/components/website-logo";
import { CLUB_NAME } from "@/config/club-identity";
import { getSiteFooterContent } from "@/lib/site-content";

// Styles the admin-editable footer HTML (sanitised on write and read) so the
// section headings, link lists, and blurb paragraph keep the same look the
// static footer used. The stored markup uses <h3> section headings, but those
// sit directly under the page <h1>, which is an h1->h3 heading-order skip on
// sparse pages (axe heading-order). demoteFooterHeadings() rewrites them to
// <h2> at render time, so the heading selectors below target h2 to preserve
// the identical visual size/weight.
const FOOTER_HTML_CLASSES =
  "[&_h2]:mb-3 [&_h2]:font-heading [&_h2]:text-lg [&_h2]:font-semibold " +
  "[&_h2]:text-brand-snow [&_ul]:text-sm [&_ul>li+li]:mt-2 [&_p]:text-sm " +
  "[&_p]:leading-relaxed [&_a]:transition-colors [&_a:hover]:text-brand-gold";

// The footer columns are siblings under the page <h1>, so their section
// headings belong at <h2>. The stored admin HTML (starter default + backfill
// migration) uses <h3>; normalise the level here at render time. This is a
// presentational a11y fix only — the stored content and its sanitiser
// allowlist are untouched, and FOOTER_HTML_CLASSES styles the resulting h2
// identically to the previous h3.
function demoteFooterHeadings(html: string): string {
  return html.replace(/<(\/?)h3\b/gi, "<$1h2");
}

// Tailwind needs literal class names, so map the computed column count.
const GRID_COLUMNS_CLASS: Record<number, string> = {
  1: "md:grid-cols-1",
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
};

export async function WebsiteFooter({
  logoDataUrl,
  pageSlug,
}: {
  logoDataUrl?: string | null;
  pageSlug: string;
}) {
  const raw = await getSiteFooterContent();
  const blurbHtml = demoteFooterHeadings(raw.blurbHtml);
  const quickLinksHtml = demoteFooterHeadings(raw.quickLinksHtml);
  const affiliationsHtml = demoteFooterHeadings(raw.affiliationsHtml);

  // The club-info column always renders because it carries the code-managed
  // logo block; an empty blurb only removes its paragraph. The link columns
  // disappear entirely when an admin saves them empty.
  const columnCount =
    1 + (quickLinksHtml ? 1 : 0) + (affiliationsHtml ? 1 : 0);

  return (
    <footer
      className="border-t border-brand-gold/15 bg-brand-charcoal text-brand-snow/90"
      data-page-slug={pageSlug}
    >
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div
          className={`grid grid-cols-1 gap-8 ${GRID_COLUMNS_CLASS[columnCount]}`}
        >
          {/* Club info (logo is code-rendered; blurb is admin-editable) */}
          <div>
            <div className="mb-3">
              <WebsiteLogo
                label={CLUB_NAME}
                logoDataUrl={logoDataUrl}
                className="max-h-10 max-w-40 brightness-110"
                textClassName="text-brand-snow"
              />
            </div>
            {blurbHtml ? (
              <div
                className={FOOTER_HTML_CLASSES}
                dangerouslySetInnerHTML={{ __html: blurbHtml }}
              />
            ) : null}
          </div>

          {/* Quick links (admin-editable) */}
          {quickLinksHtml ? (
            <div
              className={FOOTER_HTML_CLASSES}
              dangerouslySetInnerHTML={{ __html: quickLinksHtml }}
            />
          ) : null}

          {/* Affiliations (admin-editable) */}
          {affiliationsHtml ? (
            <div
              className={FOOTER_HTML_CLASSES}
              dangerouslySetInnerHTML={{ __html: affiliationsHtml }}
            />
          ) : null}
        </div>

        {/* Legal row stays code-rendered: auto year, non-removable links. */}
        <div className="mt-10 border-t border-brand-ridge/30 pt-6 text-center text-sm text-brand-snow/85">
          <p>
            &copy; {new Date().getFullYear()} {CLUB_NAME} Incorporated. All
            rights reserved.
          </p>
          <p className="mt-2 space-x-4">
            <Link
              href="/privacy"
              className="transition-colors hover:text-brand-gold"
            >
              Privacy Policy
            </Link>
            <span aria-hidden="true">&middot;</span>
            <Link
              href="/terms"
              className="transition-colors hover:text-brand-gold"
            >
              Terms of Service
            </Link>
          </p>
        </div>
      </div>
    </footer>
  );
}
