import type { Metadata } from "next";
import { ContactPageClient } from "@/app/(website)/contact/contact-page-client";
import { EmbeddedPageContentParts } from "@/components/website/embedded-page-content-parts";
import { getCachedClubIdentity } from "@/lib/public-layout-config";
import { getDefaultLodgeId } from "@/lib/lodges";
import { buildEmbeddedBody } from "@/lib/page-content-embeds";
import {
  getSanitizedPageContentByPath,
  pageContentHtmlToPlainText,
} from "@/lib/page-content-html";
import { prisma } from "@/lib/prisma";

export async function generateMetadata(): Promise<Metadata> {
  const [page, { name: clubName }] = await Promise.all([
    getSanitizedPageContentByPath("/contact"),
    getCachedClubIdentity(),
  ]);

  return {
    title: page?.title ?? "Contact Us",
    description:
      pageContentHtmlToPlainText(page?.headerText ?? "") ||
      `Get in touch with ${clubName} about the club, lodge, or booking enquiries.`,
  };
}

async function loadDefaultLodgeContact(): Promise<{
  name: string;
  address: string | null;
} | null> {
  // Default-lodge identity for the contact card (E3 #1929), replacing the old
  // hardcoded lodge-address string. Never throws — a DB miss simply hides the
  // address block.
  try {
    const defaultLodgeId = await getDefaultLodgeId(prisma);
    const lodge = await prisma.lodge.findUnique({
      where: { id: defaultLodgeId },
      select: { name: true, address: true },
    });
    return lodge ? { name: lodge.name, address: lodge.address } : null;
  } catch {
    return null;
  }
}

export default async function ContactPage() {
  const [page, lodge, clubIdentity] = await Promise.all([
    getSanitizedPageContentByPath("/contact"),
    loadDefaultLodgeContact(),
    getCachedClubIdentity(),
  ]);
  const embeddedBody = page ? await buildEmbeddedBody(page.contentHtml) : [];

  const caption = page?.caption ?? "Get in touch";
  const title = page?.title ?? "Contact Us";
  const headerText =
    page?.headerText ||
    "Have a question about the club, the lodge, or booking a stay? Get in touch and we'll get back to you.";

  return (
    <>
      <section className="bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <span className="website-eyebrow mb-4">{caption}</span>
          <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            {title}
          </h1>
          <div
            className="mt-4 max-w-2xl text-lg text-brand-snow/80"
            dangerouslySetInnerHTML={{ __html: headerText }}
          />
        </div>
      </section>

      {embeddedBody.length > 0 ? (
        <EmbeddedPageContentParts
          parts={embeddedBody}
          pageSlug="contact"
          keyPrefix="contact"
          clubIdentity={clubIdentity}
        />
      ) : (
        <ContactPageClient club={clubIdentity} lodge={lodge ?? undefined} showHero={false} />
      )}
    </>
  );
}
