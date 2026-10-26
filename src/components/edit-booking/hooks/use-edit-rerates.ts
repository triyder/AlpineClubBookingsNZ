import { useMemo } from "react";
import type { PromoPreviewEditRerates } from "@/components/promo-preview-guest";

/**
 * #4202: the officer re-rates an edit sends, built ONCE for the quote and save
 * payload and for the promo box, so the box clears the same guests' locked
 * prices as the quote and refuses the same links. The other-lodge election
 * travels only when the edit changes it (`payloadFields` answers `{}`
 * otherwise: an unchanged one would re-reprice those guests on every ordinary
 * edit); the #2337 placeholder→member links are keyed to existing guest rows;
 * and the removals and renames travel because a link is judged against them.
 */
export function useEditRerates(params: {
  linkedGuestMembers: Readonly<Record<string, { memberId: string }>>;
  otherLodgePayloadFields: () => Pick<PromoPreviewEditRerates, "otherLodgeId" | "otherLodgeMemberGuestIds">;
  removedGuestIds: ReadonlySet<string>;
  guestNameUpdates: NonNullable<PromoPreviewEditRerates["guestUpdates"]>;
}): PromoPreviewEditRerates {
  const { linkedGuestMembers, otherLodgePayloadFields, removedGuestIds, guestNameUpdates } = params;
  return useMemo(() => {
    const links = Object.entries(linkedGuestMembers).map(([guestId, candidate]) => ({
      guestId,
      memberId: candidate.memberId,
    }));
    return {
      ...otherLodgePayloadFields(),
      ...(links.length > 0 ? { linkGuestToMember: links } : {}),
      ...(removedGuestIds.size > 0 ? { removeGuestIds: Array.from(removedGuestIds) } : {}),
      ...(guestNameUpdates.length > 0 ? { guestUpdates: guestNameUpdates } : {}),
    };
  }, [linkedGuestMembers, otherLodgePayloadFields, removedGuestIds, guestNameUpdates]);
}
