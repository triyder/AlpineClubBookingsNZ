import Link from "next/link";
import { buildBookingLoginPath } from "@/lib/auth-redirect";
import { getSanitizedPageContentByPath } from "@/lib/page-content-html";
import { buildEmbeddedBody } from "@/lib/page-content-embeds";
import { EmbeddedPageContentParts } from "@/components/website/embedded-page-content-parts";

function pageSlugFromPath(path: string) {
  return path.replace(/^\//, "") || "home";
}

export default async function NotFound() {
  const page = await getSanitizedPageContentByPath("/404").catch(() => null);

  if (page) {
    const headerHtml = { __html: page.headerText };
    const embeddedBody = await buildEmbeddedBody(page.contentHtml);
    const pageSlug = pageSlugFromPath(page.path);

    return (
      <>
        <section
          className="dynamic-header bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20"
          data-page-slug={pageSlug}
        >
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            {page.caption && (
              <span className="website-eyebrow mb-4">{page.caption}</span>
            )}
            <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
              {page.title}
            </h1>
            {page.headerText && (
              <div
                className="mt-4 max-w-2xl text-lg text-brand-snow/80"
                dangerouslySetInnerHTML={headerHtml}
              />
            )}
          </div>
        </section>

        <section
          className="dynamic-body bg-brand-snow py-16 sm:py-20"
          data-page-slug={pageSlug}
        >
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            {embeddedBody.length > 0 ? (
              <div className="text-base leading-7 text-brand-deep/85 [&_a]:text-brand-charcoal [&_a]:underline [&_h1]:font-heading [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:font-heading [&_h2]:text-2xl [&_h2]:font-semibold [&_h3]:font-heading [&_h3]:text-xl [&_h3]:font-semibold [&_li]:ml-6 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-4">
                <EmbeddedPageContentParts parts={embeddedBody} pageSlug={pageSlug} keyPrefix="not-found" />
              </div>
            ) : null}
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/"
                className="inline-flex items-center justify-center rounded-lg bg-brand-charcoal px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-brand-deep"
              >
                Go Home
              </Link>
              <Link
                href={buildBookingLoginPath()}
                className="inline-flex items-center justify-center rounded-lg border border-brand-ridge/40 px-6 py-3 text-sm font-medium text-brand-charcoal transition-colors hover:bg-brand-mist"
              >
                Book a Stay
              </Link>
            </div>
          </div>
        </section>
      </>
    );
  }

  // Fallback when the /404 page content record doesn't exist yet.
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="mx-auto max-w-md px-4 text-center">
        <h1 className="mb-4 text-6xl font-bold text-gray-900">404</h1>
        <h2 className="mb-4 text-2xl font-semibold text-gray-700">
          Page Not Found
        </h2>
        <p className="mb-8 text-gray-500">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <div className="flex flex-col justify-center gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-lg bg-gray-900 px-6 py-3 text-white transition-colors hover:bg-gray-800"
          >
            Go Home
          </Link>
          <Link
            href={buildBookingLoginPath()}
            className="inline-flex items-center justify-center rounded-lg border border-gray-300 px-6 py-3 text-gray-700 transition-colors hover:bg-gray-100"
          >
            Book a Stay
          </Link>
        </div>
      </div>
    </div>
  );
}
