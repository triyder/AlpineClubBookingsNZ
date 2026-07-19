"use client";

import type { AgeTier } from "@prisma/client";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCents } from "@/lib/utils";
import { getAgeTierLabel, useAgeTierOptions } from "@/lib/use-age-tier-options";
import { GuestNightGrid } from "@/components/guest-night-grid";
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback";

// #2104: mirror of requiresAdultSupervisionReview (src/lib/booking-review.ts).
// Inlined (not imported) to match the create wizard's client-side predicate
// (use-booking-wizard.ts:180-187) and keep server-leaning modules out of the
// client bundle. The server remains the enforcer; this only drives the UI.
function editTripsAdultSupervisionReview(
  guests: Array<{ ageTier: string }>,
): boolean {
  const hasAdult = guests.some((g) => g.ageTier === "ADULT");
  const hasMinor = guests.some(
    (g) => g.ageTier === "CHILD" || g.ageTier === "YOUTH" || g.ageTier === "INFANT",
  );
  return hasMinor && !hasAdult;
}

function shiftDateKey(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** All night keys (yyyy-mm-dd) from checkIn (inclusive) to checkOut (exclusive). */
function eachNightKey(checkIn: string, checkOut: string): string[] {
  const keys: string[] = [];
  let current = checkIn;
  for (let i = 0; current < checkOut && i < 1000; i++) {
    keys.push(current);
    current = shiftDateKey(current, 1);
  }
  return keys;
}

interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  memberId?: string | null;
  stayStart?: string | null;
  stayEnd?: string | null;
  nights?: string[] | null;
  priceCents: number;
}

interface FamilyMember {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  relationship: "self" | "partner" | "dependent";
}

interface PromoInfo {
  code: string;
  type: string;
  description: string | null;
  // Set when this discount came from a work party (working bee) event's
  // internal promo rather than a manually entered code.
  workPartyEventName?: string | null;
}

interface BookingData {
  id: string;
  checkIn: string;
  checkOut: string;
  guests: Guest[];
  viewerRole: string;
  finalPriceCents: number;
  totalPriceCents: number;
  discountCents: number;
  promoAdjustmentCents: number;
  promo: PromoInfo | null;
  canEditNonMemberGuestNames: boolean;
  // Fully paid: only an identity-preserving spelling correction is allowed on a
  // free-text non-member guest (#1386). The server enforces the similarity guard.
  canFixNonMemberGuestNameTypos: boolean;
  editPolicy: {
    mode: "future" | "in-progress" | null;
    today: string;
    editableFrom: string | null;
    checkInEditable: boolean;
    // Issue #1668: an admin may override the date-window locks for this booking.
    // Optional so pre-existing fixtures stay valid; the booking page sets it.
    adminOverrideAvailable?: boolean;
  };
  // #2104: an already-flagged/reviewed booking (requiresAdminReview && a
  // non-null adminReviewStatus) must not re-prompt for a justification — the
  // server only demands a reason on the FIRST no-adult trip. Optional so
  // pre-existing fixtures/callers stay valid.
  requiresAdminReview?: boolean;
  adminReviewStatus?: string | null;
}

interface NewGuest {
  key: string; // client-side key for React
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string;
  stayStart?: string;
  stayEnd?: string;
  // Explicit included nights (issue #713), set in the multi date range grid.
  nights?: string[];
  // #1746 (admin only): this guest is added as the second occupant of a
  // shared double with their confirmed partner (a member already on the
  // booking) — capacity runs through the reserved partner slots.
  partnerSharedWithMemberId?: string;
}

// Server-computed partner-sharer quick-add candidate (#1746): a confirmed
// partner of a member already on the booking.
interface PartnerSharingCandidate {
  id: string;
  firstName: string;
  lastName: string;
  partnerOfMemberId: string;
  partnerOfName: string;
}

interface ItemizedChange {
  label: string;
  amountCents: number;
}

interface SettlementOptions {
  basisAmountCents: number;
  cardRefundAmountCents: number;
  cardRefundPercentage: number;
  accountCreditAmountCents: number;
  accountCreditPercentage: number;
  daysUntilCheckIn: number;
  requiresSettlementMethod: boolean;
}

interface QuoteResult {
  newTotalPriceCents: number;
  newDiscountCents: number;
  newPromoAdjustmentCents: number;
  newFinalPriceCents: number;
  priceDiffCents: number;
  changeFeeCents: number;
  netChargeCents: number;
  settlementOptions: SettlementOptions | null;
  capacityAvailable: boolean;
  // #1746: why a partner-shared admission was rejected (shown verbatim).
  partnerSharedReason?: string | null;
  promoStillValid: boolean;
  promoValidation: {
    valid: boolean;
    error?: string;
    code?: string;
    discountCents?: number;
    promoAdjustmentCents?: number;
  } | null;
  itemizedChanges: ItemizedChange[];
  nightDetails?: { date: string; availableBeds: number }[];
  // Issue #1668: set under an admin override when the target nights are over
  // capacity — the UI shows a warning and an explicit confirm rather than a
  // hard block.
  overCapacityConfirmRequired?: boolean;
}

function previousDateOnly(dateString: string | null) {
  if (!dateString) return null;
  const date = new Date(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function shiftDateOnly(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return dateString;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatSignedCents(cents: number) {
  const prefix = cents > 0 ? "+" : "-";
  return `${prefix}${formatCents(Math.abs(cents))}`;
}

export function EditBookingPanel({
  booking,
  canAdminOverride = false,
  onDone,
}: {
  booking: BookingData;
  // Issue #1668: admin override lifts the date-window locks for this booking.
  // (Whether the standard self-service path is available is expressed by the
  // booking.editPolicy fields the panel already reads.)
  canAdminOverride?: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const ageTierOptions = useAgeTierOptions();

  // Editable state
  const [checkIn, setCheckIn] = useState(booking.checkIn);
  const [checkOut, setCheckOut] = useState(booking.checkOut);
  const [removedGuestIds, setRemovedGuestIds] = useState<Set<string>>(new Set());
  const [addedGuests, setAddedGuests] = useState<NewGuest[]>([]);
  const [perGuestDatesEnabled, setPerGuestDatesEnabled] = useState(
    booking.guests.some(
      (guest) =>
        (guest.stayStart && guest.stayStart !== booking.checkIn) ||
        (guest.stayEnd && guest.stayEnd !== booking.checkOut)
    )
  );
  // Seeded per-guest state, extracted so the admin-override toggle (#1668) can
  // restore the exact stored baseline — resetting to {} instead would let the
  // night grid's all-nights-on fallback silently collapse a guest's gaps.
  const seedExistingGuestRanges = () =>
    Object.fromEntries(
      booking.guests.map((guest) => [
        guest.id,
        {
          stayStart: guest.stayStart ?? booking.checkIn,
          stayEnd: guest.stayEnd ?? booking.checkOut,
        },
      ])
    );
  const seedExistingGuestNights = () =>
    Object.fromEntries(
      booking.guests.map((guest) => [
        guest.id,
        guest.nights && guest.nights.length > 0
          ? [...guest.nights].sort()
          : eachNightKey(
              guest.stayStart ?? booking.checkIn,
              guest.stayEnd ?? booking.checkOut
            ),
      ])
    );
  const [existingGuestRanges, setExistingGuestRanges] = useState<
    Record<string, { stayStart: string; stayEnd: string }>
  >(seedExistingGuestRanges);
  // Multiple date ranges / per-guest night grid (issue #713). Enabled by default
  // when an existing guest already has a non-contiguous stay so the gaps show.
  const [multiDateRangesEnabled, setMultiDateRangesEnabled] = useState(() =>
    booking.guests.some((guest) => {
      const span = eachNightKey(
        guest.stayStart ?? booking.checkIn,
        guest.stayEnd ?? booking.checkOut
      ).length;
      return Boolean(guest.nights && guest.nights.length < span);
    })
  );
  // Per existing-guest night set (keyed by guest id), seeded from stored nights
  // or the contiguous range so toggling the grid never wipes a guest's gaps.
  const [existingGuestNights, setExistingGuestNights] = useState<
    Record<string, string[]>
  >(seedExistingGuestNights);
  const [guestNameEdits, setGuestNameEdits] = useState<
    Record<string, { firstName: string; lastName: string }>
  >(() =>
    Object.fromEntries(
      booking.guests.map((guest) => [
        guest.id,
        { firstName: guest.firstName, lastName: guest.lastName },
      ])
    )
  );
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
  // #1746: partner-sharer quick-adds (admin fetch only — the member family
  // route never returns them, so this stays empty for members).
  const [partnerCandidates, setPartnerCandidates] = useState<
    PartnerSharingCandidate[]
  >([]);
  const [promoAction, setPromoAction] = useState<
    { type: "keep" } | { type: "remove" } | { type: "new"; code: string }
  >({ type: "keep" });
  const [newPromoInput, setNewPromoInput] = useState("");

  // Issue #1668: admin date override. When enabled, the member-facing date
  // locks are bypassed and the admin chooses how pricing is handled. Every
  // override edit is date-only, audited, and confirmed if over capacity.
  // The override control renders only when the server says this viewer may
  // override (canAdminOverride) AND the serialised edit policy agrees (#1668).
  const adminOverrideAvailable =
    canAdminOverride && booking.editPolicy.adminOverrideAvailable !== false;
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [overridePricingMode, setOverridePricingMode] = useState<
    "shift" | "recalculate" | null
  >(null);
  const [confirmOverCapacity, setConfirmOverCapacity] = useState(false);
  // Belt-and-braces (a stale quote): an apply 409 re-surfaces the confirm flow.
  const [saveOverCapacityNights, setSaveOverCapacityNights] = useState<
    { date: string; availableBeds: number }[] | null
  >(null);
  // Owner decision (#1668 review): every override save asks the admin whether
  // the member should receive the change-notification email.
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false);
  const originalNights = useMemo(
    () => eachNightKey(booking.checkIn, booking.checkOut).length,
    [booking.checkIn, booking.checkOut],
  );
  const shiftMode = overrideEnabled && overridePricingMode === "shift";

  // Quote state
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [settlementMethod, setSettlementMethod] = useState<"card" | "credit" | null>(null);

  // Add guest form
  const [showAddForm, setShowAddForm] = useState(false);
  const [addFirstName, setAddFirstName] = useState("");
  const [addLastName, setAddLastName] = useState("");
  const [addAgeTier, setAddAgeTier] = useState<AgeTier>("ADULT");

  // Save state
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  // #2104: member-facing justification for a modification that leaves minors
  // with no adult on the booking. Shown proactively when the local predicate
  // trips, or reactively when the server returns REVIEW_JUSTIFICATION_REQUIRED.
  const [memberReviewJustification, setMemberReviewJustification] = useState("");
  const [reviewJustificationError, setReviewJustificationError] = useState("");
  const [serverRequiresJustification, setServerRequiresJustification] =
    useState(false);
  const reviewJustificationRef = useRef<HTMLTextAreaElement>(null);
  const { scrollToError } = useScrollToFeedback();
  const [requestReason, setRequestReason] = useState("");
  const [requestSubmitting, setRequestSubmitting] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [requestSuccess, setRequestSuccess] = useState("");

  const today = booking.editPolicy.today;
  const minEditableDate = booking.editPolicy.editableFrom ?? today;
  // Issue #1668: an active override lifts the check-in lock and the in-progress
  // clamps entirely (the edit is date-only), and hides the promo controls.
  const checkInLocked = overrideEnabled
    ? false
    : !booking.editPolicy.checkInEditable;
  const isInProgressEdit =
    !overrideEnabled && booking.editPolicy.mode === "in-progress";
  const promoLocked = isInProgressEdit || overrideEnabled;

  function handleCheckInChange(value: string) {
    setCheckIn(value);
    // Shift mode keeps the stay length fixed: deriving the other bound so the
    // preview and apply both see the same night count (parity is required).
    if (shiftMode && value) {
      setCheckOut(shiftDateKey(value, originalNights));
    }
  }

  function handleCheckOutChange(value: string) {
    setCheckOut(value);
    if (shiftMode && value) {
      setCheckIn(shiftDateKey(value, -originalNights));
    }
  }

  useEffect(() => {
    let cancelled = false;
    // Admin on-behalf uses the bookings-scoped picker gated on bookings:edit
    // (the booking owner is resolved server-side from the booking), so a
    // Booking Officer without membership:view still gets the member's family
    // and correct member pricing (#1376). Members use their own family route.
    const familyUrl =
      booking.viewerRole === "ADMIN"
        ? `/api/admin/bookings/${booking.id}/eligible-family`
        : "/api/members/family";

    fetch(familyUrl)
      .then((res) => (res.ok ? res.json() : { familyMembers: [] }))
      .then((data) => {
        if (!cancelled) {
          setFamilyMembers(data.familyMembers || []);
          setPartnerCandidates(data.partnerSharingCandidates || []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFamilyMembers([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [booking.id, booking.viewerRole]);

  // Check if anything has changed
  const remainingGuests = useMemo(
    () => booking.guests.filter((g) => !removedGuestIds.has(g.id)),
    [booking.guests, removedGuestIds],
  );
  const canEditPerGuestDates =
    !isInProgressEdit && !overrideEnabled && totalGuestCountCandidate() > 1;
  function totalGuestCountCandidate() {
    return remainingGuests.length + addedGuests.length;
  }

  useEffect(() => {
    if (!canEditPerGuestDates && perGuestDatesEnabled) {
      setPerGuestDatesEnabled(false);
    }
  }, [canEditPerGuestDates, perGuestDatesEnabled]);

  const getExistingGuestRange = useCallback((guest: Guest) => {
    return (
      existingGuestRanges[guest.id] ?? {
        stayStart: guest.stayStart ?? booking.checkIn,
        stayEnd: guest.stayEnd ?? booking.checkOut,
      }
    );
  }, [booking.checkIn, booking.checkOut, existingGuestRanges]);

  function updateExistingGuestRange(
    guestId: string,
    field: "stayStart" | "stayEnd",
    value: string
  ) {
    setExistingGuestRanges((prev) => ({
      ...prev,
      [guestId]: {
        stayStart: prev[guestId]?.stayStart ?? booking.checkIn,
        stayEnd: prev[guestId]?.stayEnd ?? booking.checkOut,
        [field]: value,
      },
    }));
  }

  function getGuestNameEdit(guest: Guest) {
    return (
      guestNameEdits[guest.id] ?? {
        firstName: guest.firstName,
        lastName: guest.lastName,
      }
    );
  }

  function updateGuestName(
    guestId: string,
    field: "firstName" | "lastName",
    value: string
  ) {
    setGuestNameEdits((prev) => ({
      ...prev,
      [guestId]: {
        firstName:
          prev[guestId]?.firstName ??
          booking.guests.find((guest) => guest.id === guestId)?.firstName ??
          "",
        lastName:
          prev[guestId]?.lastName ??
          booking.guests.find((guest) => guest.id === guestId)?.lastName ??
          "",
        [field]: value,
      },
    }));
  }

  function updateAddedGuestRange(
    key: string,
    field: "stayStart" | "stayEnd",
    value: string
  ) {
    setAddedGuests((prev) =>
      prev.map((guest) =>
        guest.key === key
          ? {
              ...guest,
              [field]: value,
            }
          : guest
      )
    );
  }

  const guestRangesChanged =
    perGuestDatesEnabled &&
    remainingGuests.some((guest) => {
      const range = getExistingGuestRange(guest);
      return (
        range.stayStart !== (guest.stayStart ?? booking.checkIn) ||
        range.stayEnd !== (guest.stayEnd ?? booking.checkOut)
      );
    });
  const nonMemberGuestNamesEditable =
    booking.canEditNonMemberGuestNames || booking.canFixNonMemberGuestNameTypos;
  const guestNameUpdates = useMemo(
    () =>
      nonMemberGuestNamesEditable
        ? booking.guests
            .filter((guest) => !guest.isMember && !removedGuestIds.has(guest.id))
            .map((guest) => {
              const edit = guestNameEdits[guest.id] ?? {
                firstName: guest.firstName,
                lastName: guest.lastName,
              };
              return {
                guestId: guest.id,
                firstName: edit.firstName.trim(),
                lastName: edit.lastName.trim(),
                changed:
                  edit.firstName.trim() !== guest.firstName ||
                  edit.lastName.trim() !== guest.lastName,
              };
            })
            .filter((update) => update.changed)
            .map((update) => ({
              guestId: update.guestId,
              firstName: update.firstName,
              lastName: update.lastName,
            }))
        : [],
    [
      nonMemberGuestNamesEditable,
      booking.guests,
      guestNameEdits,
      removedGuestIds,
    ]
  );
  const guestNamesChanged = guestNameUpdates.length > 0;
  // A night toggle in the grid (issue #713) is a change even when it leaves the
  // guest's overall envelope unchanged (e.g. switching off a middle night).
  const guestNightsChanged =
    multiDateRangesEnabled &&
    !isInProgressEdit &&
    remainingGuests.some((guest) => {
      const original =
        guest.nights && guest.nights.length > 0
          ? [...guest.nights].sort()
          : eachNightKey(
              guest.stayStart ?? booking.checkIn,
              guest.stayEnd ?? booking.checkOut
            );
      const current = existingGuestNights[guest.id] ?? original;
      return current.join(",") !== original.join(",");
    });
  const hasChanges =
    checkIn !== booking.checkIn ||
    checkOut !== booking.checkOut ||
    removedGuestIds.size > 0 ||
    addedGuests.length > 0 ||
    guestRangesChanged ||
    guestNightsChanged ||
    guestNamesChanged ||
    promoAction.type !== "keep";

  // Debounced quote fetch
  const quoteTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Monotonic id per quote request so a slow, superseded response can never
  // overwrite the quote for the user's latest edit.
  const quoteRequestSeqRef = useRef(0);

  const buildModificationPayload = useCallback(() => {
    // Issue #1668: an admin override is strictly date-only. Send only the dates,
    // the override flags, and the capacity confirm — never guest/promo inputs,
    // which the route/service reject anyway.
    if (overrideEnabled && overridePricingMode) {
      const overrideBody: Record<string, unknown> = {
        adminOverride: true,
        pricingMode: overridePricingMode,
      };
      if (checkIn !== booking.checkIn) overrideBody.checkIn = checkIn;
      if (checkOut !== booking.checkOut) overrideBody.checkOut = checkOut;
      if (confirmOverCapacity) overrideBody.confirmOverCapacity = true;
      return overrideBody;
    }

    const body: Record<string, unknown> = {};
    const gridMode = multiDateRangesEnabled && !isInProgressEdit;
    const rangeMode = perGuestDatesEnabled && !isInProgressEdit && !gridMode;
    let effectiveCheckIn = checkIn;
    let effectiveCheckOut = checkOut;
    let rangeAwareAddedGuests: Array<{
      firstName: string;
      lastName: string;
      ageTier: AgeTier;
      isMember: boolean;
      memberId?: string;
      stayStart?: string;
      stayEnd?: string;
      nights?: string[];
    }> = addedGuests.map((g) => ({
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      memberId: g.memberId,
    }));

    if (gridMode) {
      // Multi date range mode (issue #713): send each guest's explicit night
      // set; the server reprices, re-allocates and recomputes the envelope.
      const existingRanges = remainingGuests.map((guest) => ({
        guestId: guest.id,
        nights:
          existingGuestNights[guest.id] ??
          eachNightKey(
            guest.stayStart ?? booking.checkIn,
            guest.stayEnd ?? booking.checkOut
          ),
      }));
      rangeAwareAddedGuests = addedGuests.map((g) => ({
        firstName: g.firstName,
        lastName: g.lastName,
        ageTier: g.ageTier,
        isMember: g.isMember,
        memberId: g.memberId,
        nights: g.nights ?? eachNightKey(checkIn, checkOut),
      }));
      const allNights = [
        ...existingRanges.flatMap((range) => range.nights),
        ...rangeAwareAddedGuests.flatMap((guest) => guest.nights ?? []),
      ].filter(Boolean);
      if (allNights.length > 0) {
        effectiveCheckIn = allNights.reduce((a, b) => (b < a ? b : a), allNights[0]);
        const lastNight = allNights.reduce((a, b) => (b > a ? b : a), allNights[0]);
        effectiveCheckOut = shiftDateKey(lastNight, 1);
      }
      body.guestStayRanges = existingRanges;
    } else if (rangeMode) {
      const existingRanges = remainingGuests.map((guest) => ({
        guestId: guest.id,
        ...getExistingGuestRange(guest),
      }));
      rangeAwareAddedGuests = addedGuests.map((g) => ({
        firstName: g.firstName,
        lastName: g.lastName,
        ageTier: g.ageTier,
        isMember: g.isMember,
        memberId: g.memberId,
        stayStart: g.stayStart ?? checkIn,
        stayEnd: g.stayEnd ?? checkOut,
      }));
      const rangeValues = [
        ...existingRanges.map((range) => ({
          stayStart: range.stayStart,
          stayEnd: range.stayEnd,
        })),
        ...rangeAwareAddedGuests.map((guest) => ({
          stayStart: guest.stayStart ?? checkIn,
          stayEnd: guest.stayEnd ?? checkOut,
        })),
      ].filter((range) => range.stayStart && range.stayEnd);

      if (rangeValues.length > 0) {
        const firstRange = rangeValues[0];
        effectiveCheckIn = rangeValues.reduce(
          (earliest, range) => (range.stayStart < earliest ? range.stayStart : earliest),
          firstRange.stayStart
        );
        effectiveCheckOut = rangeValues.reduce(
          (latest, range) => (range.stayEnd > latest ? range.stayEnd : latest),
          firstRange.stayEnd
        );
      }

      body.guestStayRanges = existingRanges;
    }

    if (effectiveCheckIn !== booking.checkIn) body.checkIn = effectiveCheckIn;
    if (effectiveCheckOut !== booking.checkOut) body.checkOut = effectiveCheckOut;
    if (addedGuests.length > 0) {
      body.addGuests = rangeAwareAddedGuests;
      // #1746: partner-sharer flags for admin-added partner guests still in
      // the proposal — capacity then runs through the reserved double slots.
      const partnerSharedGuests = addedGuests
        .filter((g) => g.memberId && g.partnerSharedWithMemberId)
        .map((g) => ({
          memberId: g.memberId as string,
          partnerMemberId: g.partnerSharedWithMemberId as string,
        }));
      if (partnerSharedGuests.length > 0) {
        body.partnerSharedGuests = partnerSharedGuests;
      }
    }
    if (removedGuestIds.size > 0) {
      body.removeGuestIds = Array.from(removedGuestIds);
    }
    if (guestNameUpdates.length > 0) {
      body.guestUpdates = guestNameUpdates;
    }
    if (promoAction.type === "remove") {
      body.removePromoCode = true;
    } else if (promoAction.type === "new") {
      body.promoCode = promoAction.code;
    }

    return body;
  }, [
    addedGuests,
    booking.checkIn,
    booking.checkOut,
    checkIn,
    checkOut,
    getExistingGuestRange,
    guestNameUpdates,
    isInProgressEdit,
    perGuestDatesEnabled,
    multiDateRangesEnabled,
    existingGuestNights,
    promoAction,
    remainingGuests,
    removedGuestIds,
    overrideEnabled,
    overridePricingMode,
    confirmOverCapacity,
  ]);

  const fetchQuote = useCallback(
    async (payloadJson: string) => {
      const seq = ++quoteRequestSeqRef.current;
      setQuoteError("");
      setQuoteLoading(true);

      try {
        const res = await fetch(`/api/bookings/${booking.id}/modify-quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payloadJson,
        });

        const data = await res.json();
        // A newer edit superseded this request; drop the stale response.
        if (seq !== quoteRequestSeqRef.current) return;
        if (!res.ok) {
          setQuoteError(data.error || "Failed to get quote");
          setQuote(null);
          return;
        }
        setQuote(data);
        // A fresh quote that no longer needs an over-capacity confirm clears any
        // stale apply-side warning (#1668).
        if (!data.overCapacityConfirmRequired) {
          setSaveOverCapacityNights(null);
        }
        if (!data.settlementOptions?.requiresSettlementMethod) {
          setSettlementMethod(null);
        }
      } catch {
        if (seq !== quoteRequestSeqRef.current) return;
        setQuoteError("Failed to get quote");
        setQuote(null);
      } finally {
        if (seq === quoteRequestSeqRef.current) {
          setQuoteLoading(false);
        }
      }
    },
    [booking.id],
  );

  // Auto-fetch quote when changes happen (debounced). The effect is keyed on
  // the serialized payload, not on callback identity: several payload inputs
  // (e.g. remainingGuests) are recomputed objects, so a callback dependency
  // changes on every render — including the render caused by a completed
  // fetch — which re-armed the timer and refetched in an endless 500ms loop.
  // Under an override the pricing-mode radio must be chosen before the quote
  // fires — otherwise a member-shaped quote would run and (for a fully-past
  // booking) error, confusing the admin.
  const overrideQuoteReady = !overrideEnabled || Boolean(overridePricingMode);
  const modificationPayloadJson =
    hasChanges && overrideQuoteReady
      ? JSON.stringify(buildModificationPayload())
      : null;
  useEffect(() => {
    if (quoteTimeoutRef.current) clearTimeout(quoteTimeoutRef.current);
    if (!modificationPayloadJson) {
      setQuote(null);
      return;
    }
    quoteTimeoutRef.current = setTimeout(
      () => fetchQuote(modificationPayloadJson),
      500,
    );
    return () => {
      if (quoteTimeoutRef.current) clearTimeout(quoteTimeoutRef.current);
    };
  }, [fetchQuote, modificationPayloadJson]);

  function handleRemoveGuest(guestId: string) {
    setRemovedGuestIds((prev) => new Set([...prev, guestId]));
  }

  function handleUndoRemoveGuest(guestId: string) {
    setRemovedGuestIds((prev) => {
      const next = new Set(prev);
      next.delete(guestId);
      return next;
    });
  }

  function handleAddGuest() {
    if (!addFirstName.trim() || !addLastName.trim()) return;
    setAddedGuests((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        firstName: addFirstName.trim(),
        lastName: addLastName.trim(),
        ageTier: addAgeTier,
        isMember: false,
        ...(perGuestDatesEnabled && !isInProgressEdit
          ? { stayStart: checkIn, stayEnd: checkOut }
          : {}),
      },
    ]);
    setAddFirstName("");
    setAddLastName("");
    setShowAddForm(false);
  }

  function handleAddFamilyMember(familyMember: FamilyMember) {
    const alreadyAdded = booking.guests.some((guest) => guest.memberId === familyMember.id)
      || addedGuests.some((guest) => guest.memberId === familyMember.id);
    if (alreadyAdded) {
      return;
    }

    setAddedGuests((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        firstName: familyMember.firstName,
        lastName: familyMember.lastName,
        ageTier: familyMember.ageTier,
        isMember: true,
        memberId: familyMember.id,
        ...(perGuestDatesEnabled && !isInProgressEdit
          ? { stayStart: checkIn, stayEnd: checkOut }
          : {}),
      },
    ]);
  }

  function handleAddPartnerCandidate(candidate: PartnerSharingCandidate) {
    const alreadyAdded = booking.guests.some((guest) => guest.memberId === candidate.id)
      || addedGuests.some((guest) => guest.memberId === candidate.id);
    if (alreadyAdded) {
      return;
    }

    setAddedGuests((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        ageTier: "ADULT" as AgeTier,
        isMember: true,
        memberId: candidate.id,
        partnerSharedWithMemberId: candidate.partnerOfMemberId,
        ...(perGuestDatesEnabled && !isInProgressEdit
          ? { stayStart: checkIn, stayEnd: checkOut }
          : {}),
      },
    ]);
  }

  function handleRemoveAddedGuest(key: string) {
    setAddedGuests((prev) => prev.filter((g) => g.key !== key));
  }

  function handleApplyPromo() {
    if (promoLocked) return;
    if (!newPromoInput.trim()) return;
    setPromoAction({ type: "new", code: newPromoInput.trim() });
    setNewPromoInput("");
  }

  // Issue #1696: an admin/booking-officer save goes through the notify dialog
  // first (on EVERY edit, not just overrides); the dialog's two actions call
  // handleSave with the admin's explicit email choice. viewerRole is the same
  // booking-management role the /modify route resolves as actorRole, so the
  // dialog shows exactly when the server will honour the choice. Member
  // self-edits keep the immediate always-notify save.
  const actingAsAdmin = booking.viewerRole === "ADMIN";

  // #2104: does the post-edit guest set (remaining + added) leave minors with no
  // adult? The server (resolveModifyReviewUpdate) only demands a written reason
  // on the FIRST trip, so an already-flagged/reviewed booking never re-prompts.
  const postEditTripsReview = editTripsAdultSupervisionReview([
    ...remainingGuests.map((g) => ({ ageTier: g.ageTier })),
    ...addedGuests.map((g) => ({ ageTier: g.ageTier })),
  ]);
  const bookingAlreadyUnderReview =
    Boolean(booking.requiresAdminReview) && (booking.adminReviewStatus ?? null) !== null;
  // An admin acts through the notify dialog and auto-approves the review, so the
  // field is member-only. serverRequiresJustification covers client/server drift
  // (the reactive REVIEW_JUSTIFICATION_REQUIRED path).
  const showReviewJustification =
    (postEditTripsReview && !actingAsAdmin && !bookingAlreadyUnderReview) ||
    serverRequiresJustification;

  // In the drift case the local predicate is false by definition, so the latch
  // cannot key off it. Instead remember the guest-set signature at latch time:
  // if the member then CHANGES the guests (e.g. re-adds an adult) rather than
  // writing a reason, release the latch so they are not forced to justify a
  // rule the server will no longer apply.
  const guestSetSignature = useMemo(
    () =>
      JSON.stringify([
        remainingGuests.map((g) => g.id),
        addedGuests.map((g) => [g.firstName, g.lastName, g.ageTier]),
      ]),
    [remainingGuests, addedGuests],
  );
  const latchedGuestSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!serverRequiresJustification) {
      latchedGuestSignatureRef.current = null;
      return;
    }
    if (latchedGuestSignatureRef.current === null) {
      // Latch just set: remember the guest set and bring the freshly-mounted
      // field into view (the fetch handler ran before it existed in the DOM).
      latchedGuestSignatureRef.current = guestSetSignature;
      scrollToError(reviewJustificationRef);
      return;
    }
    if (latchedGuestSignatureRef.current !== guestSetSignature) {
      setServerRequiresJustification(false);
      setReviewJustificationError("");
      latchedGuestSignatureRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverRequiresJustification, guestSetSignature]);

  function handleSaveClick() {
    if (actingAsAdmin) {
      setNotifyDialogOpen(true);
      return;
    }
    void handleSave();
  }

  async function handleSave(notifyMemberChoice?: boolean) {
    setSaveError("");
    // #2104: block submission with an inline error adjacent to the field (not the
    // bottom saveError slot) when a required justification is missing, and bring
    // the field into view.
    if (showReviewJustification && !memberReviewJustification.trim()) {
      setReviewJustificationError(
        "Please add a reason so an admin can review this booking.",
      );
      scrollToError(reviewJustificationRef);
      return;
    }
    if (quote?.settlementOptions?.requiresSettlementMethod && !settlementMethod) {
      setSaveError("Choose a refund or account credit before saving");
      return;
    }
    setSaving(true);

    try {
      const body = buildModificationPayload();
      // #2104: attach the justification only when the field is shown (a member
      // trip). buildModificationPayload is shared with the change-request POST,
      // so the field is added here in handleSave, never in that builder.
      if (showReviewJustification) {
        body.memberReviewJustification =
          memberReviewJustification.trim() || undefined;
      }
      if (settlementMethod) {
        body.settlementMethod = settlementMethod;
      }
      // Issue #1696: send the admin's email choice on every admin edit, not just
      // overrides. notifyMemberChoice is only defined on the admin (dialog) path;
      // a member self-edit calls handleSave() with no argument and never sets it.
      if (notifyMemberChoice !== undefined) {
        body.notifyMember = notifyMemberChoice;
      }

      const res = await fetch(`/api/bookings/${booking.id}/modify`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        // #2104: the server tripped the no-adult review rule but the local
        // predicate missed it (client/server drift). Reveal the justification
        // field, show the message adjacent to it, and bring it into view.
        if (data.code === "REVIEW_JUSTIFICATION_REQUIRED") {
          // The effect keyed on serverRequiresJustification scrolls/focuses the
          // field after it mounts on the next commit.
          setServerRequiresJustification(true);
          setReviewJustificationError(
            data.error ||
              "Please add a reason so an admin can review this booking.",
          );
          return;
        }
        // Belt-and-braces (#1668): a stale quote can miss an over-capacity
        // target the apply then rejects. Re-surface the confirm flow.
        if (data.code === "OVER_CAPACITY_CONFIRM_REQUIRED") {
          setSaveOverCapacityNights(
            Array.isArray(data.nightDetails) ? data.nightDetails : [],
          );
          setConfirmOverCapacity(false);
          setSaveError(
            data.error ??
              "These nights are over lodge capacity. Confirm the override to proceed.",
          );
          return;
        }
        setSaveError(data.error || "Failed to save changes");
        return;
      }

      setSaveOverCapacityNights(null);
      router.refresh();
      onDone();
    } catch {
      setSaveError("Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmitChangeRequest() {
    setRequestError("");
    setRequestSuccess("");
    setRequestSubmitting(true);

    try {
      const body = buildModificationPayload();
      if (!hasChanges) {
        body.requestedEffectiveDate =
          previousDateOnly(booking.editPolicy.editableFrom) ?? today;
      }

      const res = await fetch(`/api/bookings/${booking.id}/change-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          reason: requestReason.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRequestError(data.error || "Failed to submit request");
        return;
      }

      setRequestReason("");
      setRequestSuccess("Request sent to admins");
    } catch {
      setRequestError("Failed to submit request");
    } finally {
      setRequestSubmitting(false);
    }
  }

  function isLockedChangeError(message: string) {
    return /locked|in-progress|check-in cannot be changed/i.test(message);
  }

  const totalGuestCount = totalGuestCountCandidate();
  const showChangeRequestPath =
    (booking.editPolicy.mode === "in-progress" && !hasChanges) ||
    (hasChanges &&
      (booking.editPolicy.mode === "future" ||
        booking.editPolicy.mode === "in-progress") &&
      (isLockedChangeError(quoteError) || isLockedChangeError(saveError)));
  const settlementRequired = quote?.settlementOptions?.requiresSettlementMethod ?? false;

  // Issue #1668: over-capacity under an admin override is a confirmable warning,
  // not a hard block. The signal can come from the quote (preview) or from a
  // stale-quote apply 409 (saveOverCapacityNights).
  const overCapacityConfirmActive =
    Boolean(quote?.overCapacityConfirmRequired) || Boolean(saveOverCapacityNights);
  const overCapacityNightList = (
    quote?.overCapacityConfirmRequired
      ? quote.nightDetails ?? []
      : saveOverCapacityNights ?? []
  ).filter((night) => night.availableBeds < 0);
  const capacityOk = quote
    ? overCapacityConfirmActive
      ? confirmOverCapacity
      : quote.capacityAvailable
    : false;
  const showQuoteSummary = Boolean(
    quote && (quote.capacityAvailable || (overCapacityConfirmActive && confirmOverCapacity)),
  );

  return (
    <div className="space-y-6">
      {/* Admin override (issue #1668) */}
      {adminOverrideAvailable && (
        <Card className="border-amber-300">
          <CardHeader>
            <CardTitle>Admin override</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={overrideEnabled}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setOverrideEnabled(enabled);
                  if (enabled) {
                    // An override edit is date-only: discard any pending guest,
                    // range, night, or promo edits so what the cards show is
                    // what the save will send — a stacked edit would otherwise
                    // be silently dropped by the date-only payload. Ranges and
                    // night sets go back to their stored seeds (not {}), so a
                    // later grid edit still sees each guest's real gaps.
                    setRemovedGuestIds(new Set());
                    setAddedGuests([]);
                    setGuestNameEdits({});
                    setExistingGuestRanges(seedExistingGuestRanges());
                    setExistingGuestNights(seedExistingGuestNights());
                    setPromoAction({ type: "keep" });
                    setNewPromoInput("");
                    setShowAddForm(false);
                  } else {
                    setOverridePricingMode(null);
                    setConfirmOverCapacity(false);
                    setSaveOverCapacityNights(null);
                  }
                }}
                className="mt-1 h-4 w-4"
              />
              <span>
                <span className="font-medium">
                  Move locked/past dates (admin override)
                </span>
                <span className="block text-gray-500">
                  Bypasses the member-facing date locks so you can move an
                  in-progress or fully-past booking. This is date-only and
                  audited — any pending guest or promo edits are cleared when
                  you turn it on. Choose how pricing is handled below.
                </span>
              </span>
            </label>

            {overrideEnabled && (
              <div className="space-y-2 rounded-md border p-3 text-sm">
                <p className="font-medium">How should pricing be handled?</p>
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="overridePricingMode"
                    value="shift"
                    checked={overridePricingMode === "shift"}
                    onChange={() => {
                      setOverridePricingMode("shift");
                      setConfirmOverCapacity(false);
                      setSaveOverCapacityNights(null);
                    }}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium">Shift dates only</span> — keep
                    the current price, payments and invoices.
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="overridePricingMode"
                    value="recalculate"
                    checked={overridePricingMode === "recalculate"}
                    onChange={() => {
                      setOverridePricingMode("recalculate");
                      setConfirmOverCapacity(false);
                      setSaveOverCapacityNights(null);
                    }}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium">Recalculate price</span> —
                    reprice the new nights and settle the difference (a change
                    fee may apply).
                  </span>
                </label>
                {!overridePricingMode && (
                  <p className="text-amber-700">
                    Choose a pricing mode to preview the change.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Dates */}
      <Card>
        <CardHeader>
          <CardTitle>Dates</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="edit-checkin">Check-in</Label>
              <Input
                id="edit-checkin"
                type="date"
                value={checkIn}
                min={overrideEnabled ? undefined : today}
                disabled={checkInLocked}
                onChange={(e) => handleCheckInChange(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-checkout">Check-out</Label>
              <Input
                id="edit-checkout"
                type="date"
                value={checkOut}
                min={isInProgressEdit ? minEditableDate : checkIn || today}
                onChange={(e) => handleCheckOutChange(e.target.value)}
              />
            </div>
          </div>
          {checkIn !== booking.checkIn || checkOut !== booking.checkOut ? (
            <p className="text-sm text-gray-500 mt-2">
              Originally: {booking.checkIn} to {booking.checkOut}
            </p>
          ) : null}
          {shiftMode ? (
            <p className="mt-2 text-sm text-slate-600">
              Shift keeps this {originalNights}-night stay the same length — the
              price stays exactly as booked.
            </p>
          ) : null}
          {isInProgressEdit ? (
            <p className="mt-2 text-sm text-amber-800">
              Self-service edits for this in-progress stay can only affect
              nights from {minEditableDate} onward. NZ today and earlier stay
              locked for admin review.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* Guests */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Guests ({totalGuestCount})</CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddForm(true)}
              disabled={showAddForm || overrideEnabled}
            >
              {isInProgressEdit ? "+ Add Future Guest" : "+ Add Guest"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {isInProgressEdit ? (
            <p className="text-sm text-gray-500">
              Added guests start on {minEditableDate}. Removing an existing
              guest keeps their past and NZ today occupancy and removes only
              future nights.
            </p>
          ) : null}
          {familyMembers.length > 0 && !overrideEnabled && (
            <div className="space-y-2 rounded-md border border-dashed p-3">
              <p className="text-sm font-medium text-muted-foreground">Quick add family members</p>
              <div className="flex flex-wrap gap-2">
                {familyMembers.map((familyMember) => {
                  const alreadyAdded = booking.guests.some((guest) => guest.memberId === familyMember.id)
                    || addedGuests.some((guest) => guest.memberId === familyMember.id);
                  const label = familyMember.relationship === "self"
                    ? `${familyMember.firstName} ${familyMember.lastName}`
                    : `${familyMember.firstName} ${familyMember.lastName} (${getAgeTierLabel(ageTierOptions, familyMember.ageTier)})`;

                  return (
                    <Button
                      key={familyMember.id}
                      type="button"
                      variant={alreadyAdded ? "secondary" : familyMember.relationship === "self" ? "default" : "outline"}
                      size="sm"
                      disabled={alreadyAdded}
                      onClick={() => handleAddFamilyMember(familyMember)}
                    >
                      {alreadyAdded ? "\u2713 " : "+ "}
                      {label}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          {partnerCandidates.length > 0 && !overrideEnabled && (
            <div className="space-y-2 rounded-md border border-dashed p-3">
              <p className="text-sm font-medium text-muted-foreground">
                Add a partner (shares a double bed)
              </p>
              <div className="flex flex-wrap gap-2">
                {partnerCandidates.map((candidate) => {
                  const alreadyAdded = booking.guests.some((guest) => guest.memberId === candidate.id)
                    || addedGuests.some((guest) => guest.memberId === candidate.id);
                  return (
                    <Button
                      key={candidate.id}
                      type="button"
                      variant={alreadyAdded ? "secondary" : "outline"}
                      size="sm"
                      disabled={alreadyAdded}
                      onClick={() => handleAddPartnerCandidate(candidate)}
                    >
                      {alreadyAdded ? "\u2713 " : "+ "}
                      {candidate.firstName} {candidate.lastName} \u2014 partner of {candidate.partnerOfName}
                    </Button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                A partner can be added even when the lodge is full by beds:
                they use a reserved double-bed slot (one per double) and must
                then be placed as the second occupant on the allocation board.
              </p>
            </div>
          )}

          {canEditPerGuestDates && !multiDateRangesEnabled ? (
            <label className="flex items-center gap-2 rounded-md border p-3 text-sm">
              <input
                type="checkbox"
                checked={perGuestDatesEnabled}
                onChange={(e) => setPerGuestDatesEnabled(e.target.checked)}
                className="h-4 w-4"
              />
              <span className="font-medium">Per guest booking dates</span>
            </label>
          ) : null}

          {!isInProgressEdit && !overrideEnabled ? (
            <div className="space-y-3 rounded-md border p-3 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={multiDateRangesEnabled}
                  onChange={(e) => {
                    setMultiDateRangesEnabled(e.target.checked);
                    if (e.target.checked) setPerGuestDatesEnabled(false);
                  }}
                  className="h-4 w-4"
                />
                <span className="font-medium">Multiple date ranges</span>
              </label>
              {multiDateRangesEnabled ? (
                <GuestNightGrid
                  guestLabels={[
                    ...remainingGuests.map(
                      (g) => `${g.firstName} ${g.lastName}`.trim(),
                    ),
                    ...addedGuests.map(
                      (g, i) =>
                        `${g.firstName} ${g.lastName}`.trim() ||
                        `New guest ${i + 1}`,
                    ),
                  ]}
                  nights={eachNightKey(checkIn, checkOut)}
                  isNightOn={(rowIndex, nightKey) => {
                    if (rowIndex < remainingGuests.length) {
                      const guest = remainingGuests[rowIndex];
                      const set = existingGuestNights[guest.id];
                      return set ? set.includes(nightKey) : true;
                    }
                    const added = addedGuests[rowIndex - remainingGuests.length];
                    return added?.nights ? added.nights.includes(nightKey) : true;
                  }}
                  onToggle={(rowIndex, nightKey) => {
                    const toggle = (current: string[]) =>
                      current.includes(nightKey)
                        ? current.filter((key) => key !== nightKey)
                        : [...current, nightKey].sort();
                    if (rowIndex < remainingGuests.length) {
                      const guest = remainingGuests[rowIndex];
                      setExistingGuestNights((prev) => {
                        const base =
                          prev[guest.id] ?? eachNightKey(checkIn, checkOut);
                        const next = toggle(base);
                        if (next.length === 0) return prev;
                        return { ...prev, [guest.id]: next };
                      });
                    } else {
                      const addedIndex = rowIndex - remainingGuests.length;
                      setAddedGuests((prev) =>
                        prev.map((g, i) => {
                          if (i !== addedIndex) return g;
                          const base = g.nights ?? eachNightKey(checkIn, checkOut);
                          const next = toggle(base);
                          if (next.length === 0) return g;
                          return { ...g, nights: next };
                        }),
                      );
                    }
                  }}
                  arrivalLabel={checkIn}
                  departureLabel={checkOut}
                />
              ) : null}
            </div>
          ) : null}

          {/* Existing guests */}
          {booking.guests.map((guest) => {
            const isRemoved = removedGuestIds.has(guest.id);
            const canEditGuestName =
              nonMemberGuestNamesEditable &&
              !guest.isMember &&
              !isRemoved &&
              !overrideEnabled;
            // Fully paid: the field is open only for a spelling correction; a
            // change of who the booking is for must go through the office (#1386).
            const showTypoOnlyHint =
              canEditGuestName &&
              !booking.canEditNonMemberGuestNames &&
              booking.canFixNonMemberGuestNameTypos;
            const nameEdit = getGuestNameEdit(guest);
            return (
              <div
                key={guest.id}
                className={`flex items-center justify-between py-2 ${
                  isRemoved ? "opacity-40 line-through" : ""
                }`}
              >
                <div>
                  {canEditGuestName ? (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label htmlFor={`guest-${guest.id}-first`} className="text-xs">
                          First Name
                        </Label>
                        <Input
                          id={`guest-${guest.id}-first`}
                          value={nameEdit.firstName}
                          onChange={(e) =>
                            updateGuestName(guest.id, "firstName", e.target.value)
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`guest-${guest.id}-last`} className="text-xs">
                          Last Name
                        </Label>
                        <Input
                          id={`guest-${guest.id}-last`}
                          value={nameEdit.lastName}
                          onChange={(e) =>
                            updateGuestName(guest.id, "lastName", e.target.value)
                          }
                        />
                      </div>
                      {showTypoOnlyHint ? (
                        <p className="col-span-2 text-xs text-gray-500">
                          Only spelling corrections are allowed after payment.
                          To change who this booking is for, contact the office.
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="font-medium">
                      {guest.firstName} {guest.lastName}
                    </p>
                  )}
                  <p className="text-sm text-gray-500">
                    {getAgeTierLabel(ageTierOptions, guest.ageTier)} &middot; {guest.isMember ? "Member" : "Non-member"}
                  </p>
                  {(guest.stayStart && guest.stayStart !== booking.checkIn) ||
                  (guest.stayEnd && guest.stayEnd !== booking.checkOut) ? (
                    <p className="text-xs text-gray-500">
                      Stay: {guest.stayStart ?? booking.checkIn} to{" "}
                      {guest.stayEnd ?? booking.checkOut}
                    </p>
                  ) : null}
                  {perGuestDatesEnabled && !isRemoved && !overrideEnabled ? (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label htmlFor={`guest-${guest.id}-stay-start`} className="text-xs">
                          Date In
                        </Label>
                        <Input
                          id={`guest-${guest.id}-stay-start`}
                          type="date"
                          value={getExistingGuestRange(guest).stayStart}
                          min={checkIn}
                          max={shiftDateOnly(getExistingGuestRange(guest).stayEnd, -1)}
                          onChange={(e) =>
                            updateExistingGuestRange(guest.id, "stayStart", e.target.value)
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`guest-${guest.id}-stay-end`} className="text-xs">
                          Date Out
                        </Label>
                        <Input
                          id={`guest-${guest.id}-stay-end`}
                          type="date"
                          value={getExistingGuestRange(guest).stayEnd}
                          min={shiftDateOnly(getExistingGuestRange(guest).stayStart, 1)}
                          max={checkOut}
                          onChange={(e) =>
                            updateExistingGuestRange(guest.id, "stayEnd", e.target.value)
                          }
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm">{formatCents(guest.priceCents)}</span>
                  {isRemoved ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleUndoRemoveGuest(guest.id)}
                    >
                      Undo
                    </Button>
                  ) : (
                    !overrideEnabled &&
                    remainingGuests.length + addedGuests.length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-500 hover:text-red-700"
                        onClick={() => handleRemoveGuest(guest.id)}
                      >
                        {isInProgressEdit ? "Remove Future" : "Remove"}
                      </Button>
                    )
                  )}
                </div>
              </div>
            );
          })}

          {/* Newly added guests */}
          {addedGuests.map((guest) => (
            <div key={guest.key} className="flex items-center justify-between py-2 bg-green-50 rounded px-2">
              <div>
                <p className="font-medium">
                  {guest.firstName} {guest.lastName}
                  <span className="ml-2 text-xs text-green-700 font-normal">NEW</span>
                </p>
                <p className="text-sm text-gray-500">
                  {getAgeTierLabel(ageTierOptions, guest.ageTier)} &middot; {guest.isMember ? "Member" : "Non-member"}
                </p>
                {perGuestDatesEnabled ? (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label htmlFor={`added-${guest.key}-stay-start`} className="text-xs">
                        Date In
                      </Label>
                      <Input
                        id={`added-${guest.key}-stay-start`}
                        type="date"
                        value={guest.stayStart ?? checkIn}
                        min={checkIn}
                        max={shiftDateOnly(guest.stayEnd ?? checkOut, -1)}
                        onChange={(e) =>
                          updateAddedGuestRange(guest.key, "stayStart", e.target.value)
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`added-${guest.key}-stay-end`} className="text-xs">
                        Date Out
                      </Label>
                      <Input
                        id={`added-${guest.key}-stay-end`}
                        type="date"
                        value={guest.stayEnd ?? checkOut}
                        min={shiftDateOnly(guest.stayStart ?? checkIn, 1)}
                        max={checkOut}
                        onChange={(e) =>
                          updateAddedGuestRange(guest.key, "stayEnd", e.target.value)
                        }
                      />
                    </div>
                  </div>
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-red-500 hover:text-red-700"
                onClick={() => handleRemoveAddedGuest(guest.key)}
              >
                Remove
              </Button>
            </div>
          ))}

          {/* Add guest inline form */}
          {showAddForm && (
            <div className="border rounded-md p-3 mt-2 space-y-3 bg-gray-50">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="new-guest-first">First Name</Label>
                  <Input
                    id="new-guest-first"
                    value={addFirstName}
                    onChange={(e) => setAddFirstName(e.target.value)}
                    placeholder="First name"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-guest-last">Last Name</Label>
                  <Input
                    id="new-guest-last"
                    value={addLastName}
                    onChange={(e) => setAddLastName(e.target.value)}
                    placeholder="Last name"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="new-guest-age">Age Category</Label>
                  <select
                    id="new-guest-age"
                    value={addAgeTier}
                    onChange={(e) => setAddAgeTier(e.target.value as AgeTier)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  >
                    {ageTierOptions.map((option) => (
                      <option key={option.tier} value={option.tier}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="text-sm text-gray-500">
                Typed-in guests are always treated as non-members and charged at non-member rates.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleAddGuest}
                  disabled={!addFirstName.trim() || !addLastName.trim()}
                >
                  Add
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowAddForm(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Promo Code */}
      {!promoLocked && (
      <Card>
        <CardHeader>
          <CardTitle>Promo Code</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {booking.promo && promoAction.type === "keep" && (
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium text-green-700">
                  {booking.promo.workPartyEventName
                    ? `Working bee: ${booking.promo.workPartyEventName}`
                    : booking.promo.code}
                </span>
                {booking.promo.description && !booking.promo.workPartyEventName && (
                  <span className="text-sm text-gray-500 ml-2">{booking.promo.description}</span>
                )}
                <span className={`text-sm ml-2 ${booking.promoAdjustmentCents > 0 ? "text-orange-700" : "text-green-600"}`}>
                  ({formatSignedCents(booking.promoAdjustmentCents)})
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-red-500 hover:text-red-700"
                onClick={() => setPromoAction({ type: "remove" })}
              >
                Remove
              </Button>
            </div>
          )}

          {promoAction.type === "remove" && booking.promo && (
            <div className="flex items-center justify-between text-gray-400">
              <div>
                <span className="line-through">
                  {booking.promo.workPartyEventName
                    ? `Working bee: ${booking.promo.workPartyEventName}`
                    : booking.promo.code}
                </span>
                <span className="text-sm ml-2">(will be removed - available for reuse)</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPromoAction({ type: "keep" })}
              >
                Undo
              </Button>
            </div>
          )}

          {promoAction.type === "new" && (
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium text-green-700">{promoAction.code.toUpperCase()}</span>
                {quote?.promoValidation?.valid && quote.promoValidation.promoAdjustmentCents !== undefined && (
                  <span className={`text-sm ml-2 ${(quote.promoValidation.promoAdjustmentCents ?? 0) > 0 ? "text-orange-700" : "text-green-600"}`}>
                    ({formatSignedCents(quote.promoValidation.promoAdjustmentCents ?? 0)})
                  </span>
                )}
                {quote?.promoValidation && !quote.promoValidation.valid && (
                  <span className="text-sm text-red-600 ml-2">
                    {quote.promoValidation.error}
                  </span>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-red-500 hover:text-red-700"
                onClick={() => setPromoAction(booking.promo ? { type: "keep" } : { type: "remove" })}
              >
                Remove
              </Button>
            </div>
          )}

          {(promoAction.type === "remove" || (!booking.promo && promoAction.type === "keep")) && (
            <div className="flex gap-2">
              <Input
                placeholder="Enter promo code"
                value={newPromoInput}
                onChange={(e) => setNewPromoInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleApplyPromo()}
              />
              <Button
                variant="outline"
                onClick={handleApplyPromo}
                disabled={!newPromoInput.trim()}
              >
                Apply
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* Price Summary */}
      {hasChanges && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Price Summary</CardTitle>
              {quoteLoading && quote && (
                <span className="text-sm font-normal text-gray-500">Updating…</span>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {quoteLoading && !quote && (
              <p className="text-sm text-gray-500">Calculating price changes...</p>
            )}

            {quoteError && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{quoteError}</div>
            )}

            {quote && !quote.capacityAvailable && !overCapacityConfirmActive && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
                <p className="font-medium">
                  {quote.partnerSharedReason ?? "Not enough beds available"}
                </p>
                {quote.nightDetails && (
                  <ul className="mt-1 list-disc pl-4">
                    {quote.nightDetails
                      .filter((n) => n.availableBeds < 0)
                      .map((n) => (
                        <li key={n.date}>
                          {n.date}: {Math.abs(n.availableBeds)} bed(s) short
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            )}

            {overCapacityConfirmActive && (
              <div className="space-y-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-medium">
                  These nights are over lodge capacity
                </p>
                {overCapacityNightList.length > 0 && (
                  <ul className="list-disc pl-4">
                    {overCapacityNightList.map((night) => (
                      <li key={night.date}>
                        {night.date}: {Math.abs(night.availableBeds)} bed(s) over
                      </li>
                    ))}
                  </ul>
                )}
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={confirmOverCapacity}
                    onChange={(e) => setConfirmOverCapacity(e.target.checked)}
                    className="mt-1 h-4 w-4"
                  />
                  <span>
                    Book over capacity anyway — I understand this overbooks the
                    lodge.
                  </span>
                </label>
              </div>
            )}

            {showQuoteSummary && quote && (
              <div className="space-y-3">
                {/* Itemized changes */}
                <div className="space-y-1">
                  {quote.itemizedChanges.map((item, i) => (
                    <div key={i} className="flex justify-between text-sm">
                      <span className="text-gray-600">{item.label}</span>
                      <span
                        className={`font-medium ${
                          item.amountCents > 0
                            ? "text-red-600"
                            : item.amountCents < 0
                              ? "text-green-600"
                              : ""
                        }`}
                      >
                        {item.amountCents > 0 ? "+" : ""}
                        {formatCents(item.amountCents)}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Totals */}
                <div className="border-t pt-2 space-y-1">
                  <div className="flex justify-between text-sm">
                    <span>Current price</span>
                    <span>{formatCents(booking.finalPriceCents)}</span>
                  </div>
                  <div className="flex justify-between font-medium">
                    <span>New price</span>
                    <span>{formatCents(quote.newFinalPriceCents)}</span>
                  </div>
                </div>

                {/* Net charge/refund */}
                {quote.netChargeCents !== 0 && (
                  <div
                    className={`rounded-md p-3 text-sm ${
                      quote.netChargeCents > 0
                        ? "bg-red-50 text-red-700"
                        : "bg-green-50 text-green-700"
                    }`}
                  >
                    {quote.netChargeCents > 0 ? (
                      <p className="font-medium">
                        Additional charge: {formatCents(quote.netChargeCents)}
                      </p>
                    ) : (
                      <p className="font-medium">
                        Booking reduction: {formatCents(Math.abs(quote.netChargeCents))}
                      </p>
                    )}
                  </div>
                )}

                {quote.netChargeCents < 0 && quote.settlementOptions && (
                  <div className="space-y-2 rounded-md border p-3 text-sm">
                    <p className="font-medium">Return method</p>
                    {quote.settlementOptions.requiresSettlementMethod ? (
                      <div className="space-y-2">
                        <label className="flex cursor-pointer items-start gap-2">
                          <input
                            type="radio"
                            name="settlementMethod"
                            value="card"
                            checked={settlementMethod === "card"}
                            onChange={() => setSettlementMethod("card")}
                            className="mt-1"
                          />
                          <span>
                            Refund to original card:{" "}
                            <span className="font-medium">
                              {formatCents(quote.settlementOptions.cardRefundAmountCents)}
                            </span>{" "}
                            <span className="text-gray-500">
                              ({quote.settlementOptions.cardRefundPercentage}%)
                            </span>
                          </span>
                        </label>
                        <label className="flex cursor-pointer items-start gap-2">
                          <input
                            type="radio"
                            name="settlementMethod"
                            value="credit"
                            checked={settlementMethod === "credit"}
                            onChange={() => setSettlementMethod("credit")}
                            className="mt-1"
                          />
                          <span>
                            Hold as account credit:{" "}
                            <span className="font-medium">
                              {formatCents(quote.settlementOptions.accountCreditAmountCents)}
                            </span>{" "}
                            <span className="text-gray-500">
                              ({quote.settlementOptions.accountCreditPercentage}%)
                            </span>
                          </span>
                        </label>
                      </div>
                    ) : (
                      <p className="text-gray-600">
                        No refund or account credit is available for this reduction under the current policy.
                      </p>
                    )}
                  </div>
                )}

                {!quote.promoStillValid && promoAction.type === "keep" && booking.promo && (
                  <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-700">
                    Your promo code &apos;{booking.promo.code}&apos; is no longer valid and will be removed.
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {showChangeRequestPath && (
        <Card>
          <CardHeader>
            <CardTitle>Admin Request</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="change-request-reason">Requested change</Label>
              <Textarea
                id="change-request-reason"
                value={requestReason}
                maxLength={2000}
                onChange={(event) => setRequestReason(event.target.value)}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={handleSubmitChangeRequest}
              disabled={requestSubmitting || (!hasChanges && !requestReason.trim())}
            >
              {requestSubmitting ? "Sending..." : "Request Admin Review"}
            </Button>
            {requestError && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
                {requestError}
              </div>
            )}
            {requestSuccess && (
              <div className="rounded-md bg-green-50 p-3 text-sm text-green-700">
                {requestSuccess}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* #2104: required justification when the edit leaves minors with no adult.
          Rendered above the save footer; the inline error sits with the field
          (not the bottom saveError slot) so a member cannot miss it. */}
      {showReviewJustification && (
        <div className="space-y-2 rounded-md border border-warning/20 bg-warning-muted p-4">
          <Label htmlFor="edit-review-justification" className="text-warning">
            Reason for leaving no adult on the booking (required)
          </Label>
          <p className="text-sm text-warning">
            This change would leave the minors on this booking with no adult. Please
            explain why so an admin can review it. The booking is blocked from lodge
            check-in until an admin approves it.
          </p>
          <Textarea
            id="edit-review-justification"
            ref={reviewJustificationRef}
            value={memberReviewJustification}
            onChange={(e) => {
              setMemberReviewJustification(e.target.value);
              if (reviewJustificationError) setReviewJustificationError("");
            }}
            rows={3}
            maxLength={1000}
            placeholder="Explain why an adult is not on the booking..."
            aria-invalid={reviewJustificationError ? true : undefined}
            aria-describedby={
              reviewJustificationError
                ? "edit-review-justification-error"
                : undefined
            }
          />
          {reviewJustificationError && (
            <p
              id="edit-review-justification-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {reviewJustificationError}
            </p>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button
          onClick={handleSaveClick}
          disabled={
            !hasChanges ||
            saving ||
            quoteLoading ||
            !quote ||
            !capacityOk ||
            (settlementRequired && !settlementMethod)
          }
        >
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>

      {saveError && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{saveError}</div>
      )}

      {/* Owner decision (#1668/#1696): the admin explicitly chooses, per edit,
          whether the member is emailed. Both choices save the booking; the
          choice itself is recorded in the audit log. */}
      <Dialog
        open={notifyDialogOpen}
        onOpenChange={(open) => !saving && setNotifyDialogOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Email the member about this change?</DialogTitle>
            <DialogDescription>
              The booking will be updated either way. Choose whether the member
              receives the standard change-notification email — your choice is
              recorded in the audit log.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => {
                setNotifyDialogOpen(false);
                void handleSave(false);
              }}
            >
              Save without emailing
            </Button>
            <Button
              disabled={saving}
              onClick={() => {
                setNotifyDialogOpen(false);
                void handleSave(true);
              }}
            >
              Save and email member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
