/**
 * One guest as a promo preview (`POST /api/promo-codes/validate`) is sent them:
 * THE request shape, shared by every caller (#4199, `INV-SSOT-001`).
 *
 * There used to be three hand-written copies of this mapping — the one-code
 * input, the several-code list and the create wizard's working-bee preview —
 * and none of them carried a guest's night set (#713). A guest the grid gave the
 * 10th and 12th was therefore previewed over the 10th to the 12th: three nights
 * where the quote and the save price two, so the promo box disagreed with both.
 * A field added here reaches every preview at once.
 */
export type PromoPreviewGuest = {
  ageTier: string;
  isMember: boolean;
  memberId?: string;
  stayStart?: string;
  stayEnd?: string;
  /** The guest's own nights (`yyyy-mm-dd`) when a night grid chose them. */
  nights?: readonly string[];
  /** On an edit: the row this guest already is, so their stored consent counts. */
  bookingGuestId?: string;
};

/**
 * The guest's request fields. `bookingGuestId` travels only with a booking id,
 * because the server reads it only against the booking being edited.
 */
export function promoPreviewGuestBody(
  guest: PromoPreviewGuest,
  options: { bookingId?: string } = {},
): Record<string, unknown> {
  return {
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    ...(guest.memberId ? { memberId: guest.memberId } : {}),
    ...(guest.stayStart ? { stayStart: guest.stayStart } : {}),
    ...(guest.stayEnd ? { stayEnd: guest.stayEnd } : {}),
    ...(guest.nights && guest.nights.length > 0 ? { nights: [...guest.nights] } : {}),
    ...(options.bookingId && guest.bookingGuestId ? { bookingGuestId: guest.bookingGuestId } : {}),
  };
}

/**
 * #4202: the officer re-rates an edit sends the quote (`modify-quote`): the
 * other-lodge election (`useOtherLodgeRate().payloadFields()`) and the #2337
 * placeholder-to-member links, with the guest removals and renames the server
 * judges a link against. The promo preview is sent the same fields, so the
 * server clears the same guests' locked prices for the box as for the quote,
 * and refuses the same links. Built once by the edit panel for both requests.
 */
export type PromoPreviewEditRerates = {
  otherLodgeId?: string | null;
  otherLodgeMemberGuestIds?: string[];
  linkGuestToMember?: Array<{ guestId: string; memberId: string }>;
  removeGuestIds?: string[];
  guestUpdates?: Array<{ guestId: string; firstName: string; lastName: string }>;
};

/** The re-rate fields, sent only with a booking id (the server reads them only then). */
export function promoPreviewEditRerateBody(options: {
  bookingId?: string;
  editRerates?: PromoPreviewEditRerates;
}): PromoPreviewEditRerates {
  return options.bookingId && options.editRerates ? { ...options.editRerates } : {};
}
