import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EmbeddedPageContentParts } from "@/components/website/embedded-page-content-parts";
import { CLUB_NAME } from "@/config/club-identity";
import {
  getSanitizedPageContentByPath,
  pageContentHtmlToPlainText,
} from "@/lib/page-content-html";
import { buildEmbeddedBody } from "@/lib/page-content-embeds";

function pageSlugFromPath(path: string) {
  return path.replace(/^\//, "") || "home";
}

export async function generateMetadata(): Promise<Metadata> {
  const page = await getSanitizedPageContentByPath("/home");

  if (!page) {
    return {
      title: CLUB_NAME,
    };
  }

  return {
    title: page.title,
    description:
      pageContentHtmlToPlainText(page.headerText) ||
      `${page.title} information for ${CLUB_NAME}.`,
  };
}

export default async function HomePage() {
  const page = await getSanitizedPageContentByPath("/home");

  if (!page) {
    notFound();
  }

  const embeddedBody = await buildEmbeddedBody(page.contentHtml);
  const pageSlug = pageSlugFromPath(page.path);

  return (
    <>
      <section
        className="dynamic-header bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20"
        data-page-slug={pageSlug}
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <span className="website-eyebrow mb-4">{page.caption}</span>
          <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            {page.title}
          </h1>
          <div
            className="mt-4 max-w-2xl text-lg text-brand-snow/80"
            dangerouslySetInnerHTML={{ __html: page.headerText }}
          />
        </div>
      </section>
      <section
        className="dynamic-body bg-brand-snow py-16 sm:py-20"
        data-page-slug={pageSlug}
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {embeddedBody.length > 0 ? (
            <div className="space-y-10 text-base leading-7 text-brand-deep/85 [&_a]:text-brand-charcoal [&_a]:underline [&_h1]:font-heading [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:font-heading [&_h2]:text-2xl [&_h2]:font-semibold [&_h3]:font-heading [&_h3]:text-xl [&_h3]:font-semibold [&_li]:ml-6 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-4">
              <EmbeddedPageContentParts parts={embeddedBody} pageSlug={pageSlug} />
            </div>
          ) : (
            <div
              className="dynamic-empty rounded-lg border border-brand-ridge/35 bg-brand-mist/35 p-6 text-brand-deep/75"
              data-page-slug={pageSlug}
            >
              No content has been published for this page yet.
            </div>
          )}
        </div>
      </section>
    </>
  );
}
