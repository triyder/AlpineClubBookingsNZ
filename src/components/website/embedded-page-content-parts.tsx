import { ContactPageClient } from "@/app/(website)/contact/contact-page-client";
import { JoinApplyPageClient } from "@/app/(website)/join/apply/join-apply-page-client";
import { CommitteeMembersGrid } from "@/components/website/committee-members-grid";
import { PhotoGalleryToken } from "@/components/website/photo-gallery-token";
import { SkifieldConditionsWidget } from "@/components/website/skifield-conditions-widget";
import { SkifieldWhakapapaWidget } from "@/components/website/skifield-whakapapa-widget";
import { clubIdentity } from "@/config/club-identity";
import type { EmbeddedBodyPart } from "@/lib/page-content-embeds";
import {
  BookingPolicyToken,
  CancellationPolicyToken,
  EntranceFeesToken,
  HutFeesToken,
  MembershipTypesToken,
} from "@/components/website/public-page-content-token";

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

        if (part.type === "membership-types") return <MembershipTypesToken key={`${keyPrefix}-membership-types-${index}`} items={part.items} />;
        if (part.type === "entrance-fees") return <EntranceFeesToken key={`${keyPrefix}-entrance-fees-${index}`} items={part.items} />;
        if (part.type === "hut-fees") return <HutFeesToken key={`${keyPrefix}-hut-fees-${index}`} lodges={part.lodges} />;
        if (part.type === "booking-policy-summary") return <BookingPolicyToken key={`${keyPrefix}-booking-policy-${index}`} policy={part.policy} />;
        if (part.type === "cancellation-policy") return <CancellationPolicyToken key={`${keyPrefix}-cancellation-policy-${index}`} policy={part.policy} />;

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
