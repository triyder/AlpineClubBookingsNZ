import { ContactPageClient } from "@/app/(website)/contact/contact-page-client";
import { JoinApplyPageClient } from "@/app/(website)/join/apply/join-apply-page-client";
import { CommitteeMembersGrid } from "@/components/website/committee-members-grid";
import { PhotoGalleryToken } from "@/components/website/photo-gallery-token";
import { SkifieldConditionsWidget } from "@/components/website/skifield-conditions-widget";
import { SkifieldWhakapapaWidget } from "@/components/website/skifield-whakapapa-widget";
import { clubIdentity } from "@/config/club-identity";
import type { EmbeddedBodyPart } from "@/lib/page-content-embeds";

type EmbeddedPageContentPartsProps = {
  parts: EmbeddedBodyPart[];
  pageSlug: string;
  keyPrefix?: string;
};

function galleryIdSlug(pageSlug: string) {
  return pageSlug.replace(/[^a-z0-9_-]+/gi, "-") || "page";
}

export function EmbeddedPageContentParts({
  parts,
  pageSlug,
  keyPrefix = "embedded",
}: EmbeddedPageContentPartsProps) {
  const idSlug = galleryIdSlug(pageSlug);

  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "committee") {
          return <CommitteeMembersGrid key={`${keyPrefix}-committee-${index}`} />;
        }

        if (part.type === "member-application-form") {
          return (
            <JoinApplyPageClient
              key={`${keyPrefix}-member-application-form-${index}`}
              club={clubIdentity}
              showHero={false}
            />
          );
        }

        if (part.type === "contact-form") {
          return (
            <ContactPageClient
              key={`${keyPrefix}-contact-form-${index}`}
              club={clubIdentity}
              showHero={false}
            />
          );
        }

        if (part.type === "skifield-conditions") {
          return (
            <SkifieldConditionsWidget
              key={`${keyPrefix}-skifield-conditions-${index}`}
              dataHash={part.dataHash}
            />
          );
        }

        if (part.type === "skifield-whakapapa") {
          return (
            <SkifieldWhakapapaWidget
              key={`${keyPrefix}-skifield-whakapapa-${index}`}
            />
          );
        }

        if (part.type === "photo-gallery") {
          return (
            <PhotoGalleryToken
              key={`${keyPrefix}-photo-gallery-${index}`}
              galleryId={`photo-gallery-${idSlug}-${index}`}
              variant="gallery"
              images={part.images}
            />
          );
        }

        if (part.type === "photo-slideshow") {
          return (
            <PhotoGalleryToken
              key={`${keyPrefix}-photo-slideshow-${index}`}
              galleryId={`photo-slideshow-${idSlug}-${index}`}
              variant="slideshow"
              images={part.images}
            />
          );
        }

        return (
          <div
            key={`${keyPrefix}-html-${index}`}
            dangerouslySetInnerHTML={{ __html: part.value }}
          />
        );
      })}
    </>
  );
}
