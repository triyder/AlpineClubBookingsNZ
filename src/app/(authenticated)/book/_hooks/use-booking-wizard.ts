"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { type GuestData } from "@/components/guest-form";
import { useClubIdentity } from "@/components/club-identity-provider";
import { type PromoResult } from "@/components/promo-code-input";
import {
  getBookingErrorPaymentTargets,
  type BookingErrorPaymentTarget,
} from "@/lib/booking-error-payment-targets";
import { formatLocalDateOnly } from "@/lib/date-only";
import { shouldShowInviteFamilyGroupMembersLink } from "@/lib/family-booking";
import { hasAdminAccess } from "@/lib/access-roles";
import { isPaymentOwedBookingStatus } from "@/lib/booking-status";
import { MEMBER_ONBOARDING_CONFIRMED_EVENT } from "@/lib/member-onboarding-events";
import {
  type AvailablePromoCode,
  type BookingPaymentMethod,
  type BookingWizardStep,
  type CreatedBooking,
  type FamilyMember,
  type GroupPaymentMode,
  type PriceQuote,
  type RoomOption,
  type WorkPartyEvent,
} from "../_components/types";

interface GuestProfileRequiredMember {
  memberId: string;
  name: string;
  canCurrentUserResolve: boolean;
  needsOwnLoginConfirmation: boolean;
  missingFields: string[];
  action:
    | "complete_details"
    | "own_login_required"
    | "pending_admin_approval"
    | "contact_admin";
}

interface BookingMemberNightConflict {
  memberId: string;
  memberName: string;
  bookingId: string;
  bookingStatus: string;
  bookingOwnerName: string;
  bookingCheckIn: string;
  bookingCheckOut: string;
  guestId: string;
  conflictingNights: string[];
  canOpenBooking: boolean;
  canSelfRemove: boolean;
}

interface AvailabilityNightDetail {
  date: string;
  availableBeds: number;
}

interface SubscriptionStatus {
  status: "PAID" | "UNPAID" | "OVERDUE" | "NOT_INVOICED" | "NOT_REQUIRED" | "UNKNOWN";
  seasonDisplay: string;
  invoiceUrl: string | null;
  invoiceNumber: string | null;
}

type BookingMessageMap = Record<string, string>;

const UNKNOWN_SUBSCRIPTION_STATUS: SubscriptionStatus = {
  status: "UNKNOWN",
  seasonDisplay: "",
  invoiceUrl: null,
  invoiceNumber: null,
};

function clearGuestStayRanges(guestList: GuestData[]): GuestData[] {
  return guestList.map((guest) => {
    const nextGuest = { ...guest };
    delete nextGuest.stayStart;
    delete nextGuest.stayEnd;
    return nextGuest;
  });
}

function clearGuestNights(guestList: GuestData[]): GuestData[] {
  return guestList.map((guest) => {
    const nextGuest = { ...guest };
    delete nextGuest.nights;
    return nextGuest;
  });
}

// Booking wizard state machine (#1209). Extracted verbatim from the /book page
// shell: the same 51 useState, 9 useEffect (identical bodies, deps, and order),
// and handlers. The page renders the _components step views with this hook's
// return. The BookErrorPaymentTarget type is referenced via state below.
export function useBookingWizard() {
  const router = useRouter();
  const { data: session } = useSession();
  const { lodgeCapacity } = useClubIdentity();
  const [step, setStep] = useState<BookingWizardStep>("dates");
  // Set when the booking is created on the card-payment path; drives step 4.
  const [createdBooking, setCreatedBooking] = useState<CreatedBooking | null>(
    null,
  );
  const [checkIn, setCheckIn] = useState<Date | null>(null);
  const [checkOut, setCheckOut] = useState<Date | null>(null);
  const [guests, setGuests] = useState<GuestData[]>([]);
  const [notes, setNotes] = useState("");
  const [priceQuote, setPriceQuote] = useState<PriceQuote | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);
  const [error, setError] = useState("");
  const [errorPaymentTargets, setErrorPaymentTargets] = useState<
    BookingErrorPaymentTarget[]
  >([]);
  const [subscriptionInvoiceUrl, setSubscriptionInvoiceUrl] = useState<string | null>(null);
  const [subscriptionInvoiceNumber, setSubscriptionInvoiceNumber] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [showWaitlistPrompt, setShowWaitlistPrompt] = useState(false);
  const [waitlistFullNights, setWaitlistFullNights] = useState<string[]>([]);
  const [joiningWaitlist, setJoiningWaitlist] = useState(false);
  const [availableBeds, setAvailableBeds] = useState(lodgeCapacity);
  const [availabilityNightDetails, setAvailabilityNightDetails] = useState<AvailabilityNightDetail[]>([]);
  const [perGuestDatesEnabled, setPerGuestDatesEnabled] = useState(false);
  // Issue #713 — per-guest non-contiguous night grid.
  const [multiDateRangesEnabled, setMultiDateRangesEnabled] = useState(false);
  const [appliedPromo, setAppliedPromo] = useState<PromoResult | null>(null);
  const [expectedArrivalTime, setExpectedArrivalTime] = useState<string | null>(null);
  const [requestedRoomId, setRequestedRoomId] = useState<string | null>(null);
  // "Only book if my guests can come" — opt into whole-booking cancellation
  // instead of the default partial bump for non-member guests.
  const [cancelIfGuestsBumped, setCancelIfGuestsBumped] = useState(false);
  const [roomOptions, setRoomOptions] = useState<RoomOption[]>([]);
  const [roomRequestEnabled, setRoomRequestEnabled] = useState(false);
  const [useCredit, setUseCredit] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<BookingPaymentMethod>("stripe");
  const [internetBankingEnabled, setInternetBankingEnabled] = useState(false);
  // Group trip: capture the intent up front and auto-open the group right
  // after the booking is created, instead of leaving the feature to be
  // discovered on the booking page after payment.
  const [groupBookingsEnabled, setGroupBookingsEnabled] = useState(false);
  const [groupTrip, setGroupTrip] = useState(false);
  const [groupPaymentMode, setGroupPaymentMode] = useState<GroupPaymentMode>(
    "EACH_PAYS_OWN",
  );
  const [internetBankingUnavailableReason, setInternetBankingUnavailableReason] = useState<string | null>(null);
  const [internetBankingHoldSummary, setInternetBankingHoldSummary] = useState<string | null>(null);
  const [bookingMessages, setBookingMessages] = useState<BookingMessageMap>({});
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null>(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(true);
  const [availablePromoCodes, setAvailablePromoCodes] = useState<AvailablePromoCode[]>([]);
  const [prefillPromoCode, setPrefillPromoCode] = useState<string | undefined>();
  // Promo codes module: the available-codes route 404s when the module is off,
  // so hide the code entry rather than show an input that can't validate.
  const [promoCodesEnabled, setPromoCodesEnabled] = useState(true);
  const [activeWorkPartyEvents, setActiveWorkPartyEvents] = useState<WorkPartyEvent[]>([]);
  const [attendingWorkParty, setAttendingWorkParty] = useState(false);
  const [selectedWorkPartyEventId, setSelectedWorkPartyEventId] = useState<string | null>(null);
  const [workPartyError, setWorkPartyError] = useState("");
  const [workPartyClearedNotice, setWorkPartyClearedNotice] = useState<string | null>(null);
  const [guestProfileBlocks, setGuestProfileBlocks] = useState<GuestProfileRequiredMember[]>([]);
  const [memberNightConflicts, setMemberNightConflicts] = useState<BookingMemberNightConflict[]>([]);
  const [removingConflictGuestId, setRemovingConflictGuestId] = useState<string | null>(null);
  const [memberReviewJustification, setMemberReviewJustification] = useState("");
  const requiresAdminReviewLocal = (() => {
    if (guests.length === 0) return false;
    const hasAdult = guests.some((g) => g.ageTier === "ADULT");
    const hasMinor = guests.some(
      (g) => g.ageTier === "YOUTH" || g.ageTier === "CHILD" || g.ageTier === "INFANT",
    );
    return hasMinor && !hasAdult;
  })();

  function getBookingDateStrings() {
    if (!checkIn || !checkOut) {
      return null;
    }

    return {
      checkIn: formatLocalDateOnly(checkIn),
      checkOut: formatLocalDateOnly(checkOut),
    };
  }

  function withDefaultGuestStayRanges(guestList: GuestData[]): GuestData[] {
    const dateStrings = getBookingDateStrings();
    if (!dateStrings) {
      return guestList;
    }

    return guestList.map((guest) => ({
      ...guest,
      stayStart: guest.stayStart || dateStrings.checkIn,
      stayEnd: guest.stayEnd || dateStrings.checkOut,
    }));
  }

  function buildGuestPayload(): GuestData[] {
    if (multiDateRangesEnabled) {
      // Send the explicit night set per guest (issue #713); drop the contiguous
      // range so the server prices/holds only the selected nights. A guest with
      // no toggles (nights undefined) stays the whole range.
      return clearGuestStayRanges(guests);
    }
    if (!perGuestDatesEnabled) {
      return clearGuestNights(clearGuestStayRanges(guests));
    }

    return clearGuestNights(withDefaultGuestStayRanges(guests));
  }

  function handlePerGuestDatesEnabledChange(enabled: boolean) {
    setPerGuestDatesEnabled(enabled);
    setAppliedPromo(null);
    setPriceQuote(null);
    setUseCredit(false);
    setMemberNightConflicts([]);
    setGuests((current) =>
      enabled ? withDefaultGuestStayRanges(current) : clearGuestStayRanges(current)
    );
  }

  function handleMultiDateRangesEnabledChange(enabled: boolean) {
    setMultiDateRangesEnabled(enabled);
    setAppliedPromo(null);
    setPriceQuote(null);
    setUseCredit(false);
    setMemberNightConflicts([]);
    if (enabled) {
      // Multiple date ranges supersedes the simple per-guest date inputs.
      setPerGuestDatesEnabled(false);
      setGuests((current) => clearGuestStayRanges(current));
    } else {
      setGuests((current) => clearGuestNights(current));
    }
  }

  function handleGuestsChange(nextGuests: GuestData[]) {
    setGuests(nextGuests);
    setAppliedPromo(null);
    setPriceQuote(null);
    setUseCredit(false);
    setMemberNightConflicts([]);
  }

  function validateGuestStayRanges(guestList: GuestData[]): string | null {
    if (multiDateRangesEnabled || !perGuestDatesEnabled) {
      return null;
    }

    const dateStrings = getBookingDateStrings();
    if (!dateStrings) {
      return "Select booking dates first.";
    }

    for (const [index, guest] of guestList.entries()) {
      const label = `Guest ${index + 1}`;
      if (!guest.stayStart || !guest.stayEnd) {
        return `${label}: select Date In and Date Out.`;
      }
      if (guest.stayEnd <= guest.stayStart) {
        return `${label}: Date Out must be after Date In.`;
      }
      if (guest.stayStart < dateStrings.checkIn || guest.stayEnd > dateStrings.checkOut) {
        return `${label}: guest dates must stay within the booking dates.`;
      }
    }

    return null;
  }

  function getCapacityExceededNights(guestList: GuestData[]): string[] {
    const dateStrings = getBookingDateStrings();
    if (!dateStrings) {
      return [];
    }
    if (availabilityNightDetails.length === 0) {
      return guestList.length > availableBeds ? [dateStrings.checkIn] : [];
    }

    return availabilityNightDetails
      .filter((night) => {
        const activeGuests = guestList.filter((guest) => {
          const stayStart = guest.stayStart ?? dateStrings.checkIn;
          const stayEnd = guest.stayEnd ?? dateStrings.checkOut;
          return stayStart <= night.date && night.date < stayEnd;
        }).length;
        return activeGuests > night.availableBeds;
      })
      .map((night) => night.date);
  }

  function formatCapacityExceededMessage(fullNights: string[]) {
    if (fullNights.length === 1) {
      return `The lodge does not have enough beds on ${fullNights[0]}`;
    }

    return `The lodge does not have enough beds on ${fullNights.length} nights`;
  }

  useEffect(() => {
    if (guests.length <= 1 && perGuestDatesEnabled) {
      setPerGuestDatesEnabled(false);
      setGuests((current) => clearGuestStayRanges(current));
    }
  }, [guests.length, perGuestDatesEnabled]);

  // Redirect admins to the admin booking page — admins must book on behalf of members
  useEffect(() => {
    if (session?.user && hasAdminAccess(session.user)) {
      router.replace("/admin/book");
    }
  }, [session, router]);

  useEffect(() => {
    const loadFamilyMembers = () => {
      fetch("/api/members/family")
        .then((res) => res.ok ? res.json() : { familyMembers: [] })
        .then((data) => setFamilyMembers(data.familyMembers || []))
        .catch(() => {});
    };
    loadFamilyMembers();
    // The confirm-details wizard overlays this page on a member's first visit;
    // completing it flips canBeBookedAsMember, so the cached list must refetch
    // or the member's own quick-add button stays disabled until a reload.
    window.addEventListener(MEMBER_ONBOARDING_CONFIRMED_EVENT, loadFamilyMembers);
    return () =>
      window.removeEventListener(MEMBER_ONBOARDING_CONFIRMED_EVENT, loadFamilyMembers);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (checkIn) {
      params.set("checkIn", formatLocalDateOnly(checkIn));
    }
    const query = params.toString();
    fetch(`/api/payments/options${query ? `?${query}` : ""}`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        const internetBanking = data?.methods?.internetBanking;
        setInternetBankingEnabled(
          Boolean(internetBanking?.enabled)
        );
        setInternetBankingUnavailableReason(
          typeof internetBanking?.unavailableReason === "string"
            ? internetBanking.unavailableReason
            : null,
        );
        setInternetBankingHoldSummary(
          typeof internetBanking?.holdPolicy?.summary === "string"
            ? internetBanking.holdPolicy.summary
            : null,
        );
        setGroupBookingsEnabled(Boolean(data?.groupBookingsEnabled));
      })
      .catch(() => {
        setInternetBankingEnabled(false);
        setInternetBankingUnavailableReason(null);
        setInternetBankingHoldSummary(null);
      });
  }, [checkIn]);

  useEffect(() => {
    fetch("/api/booking-messages")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setBookingMessages(data?.messages ?? {}))
      .catch(() => setBookingMessages({}));
  }, []);

  useEffect(() => {
    fetch("/api/bookings/rooms")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        setRoomRequestEnabled(Boolean(data?.enabled));
        setRoomOptions(data?.rooms ?? []);
      })
      .catch(() => {
        setRoomRequestEnabled(false);
        setRoomOptions([]);
      });
  }, []);

  // Fetch subscription status for the current season
  useEffect(() => {
    let cancelled = false;

    fetch("/api/member/subscription-status")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (cancelled) {
          return;
        }
        if (data) {
          setSubscriptionStatus(data);
          setSubscriptionInvoiceUrl(data.invoiceUrl ?? null);
          setSubscriptionInvoiceNumber(data.invoiceNumber ?? null);
        } else {
          setSubscriptionStatus(UNKNOWN_SUBSCRIPTION_STATUS);
          setSubscriptionInvoiceUrl(null);
          setSubscriptionInvoiceNumber(null);
        }
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setSubscriptionStatus(UNKNOWN_SUBSCRIPTION_STATUS);
        setSubscriptionInvoiceUrl(null);
        setSubscriptionInvoiceNumber(null);
      })
      .finally(() => {
        if (!cancelled) {
          setSubscriptionLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  function addFamilyMemberAsGuest(fm: FamilyMember) {
    if (guests.some((g) => g.memberId === fm.id)) return;
    if (guests.length >= lodgeCapacity) return;
    if (fm.canBeBooked === false) return;
    const dateStrings = getBookingDateStrings();
    setAppliedPromo(null);
    setPriceQuote(null);
    setUseCredit(false);
    setMemberNightConflicts([]);
    setGuests([
      ...guests,
      {
        firstName: fm.firstName,
        lastName: fm.lastName,
        ageTier: fm.ageTier,
        isMember: true,
        memberId: fm.id,
        ...(perGuestDatesEnabled && dateStrings
          ? { stayStart: dateStrings.checkIn, stayEnd: dateStrings.checkOut }
          : {}),
      },
    ]);
  }

  function handleGuestProfileRequired(data: {
    error?: string;
    members?: GuestProfileRequiredMember[];
  }) {
    setError(
      data.error ||
        "Some member guests need their details completed or confirmed before booking."
    );
    setGuestProfileBlocks(data.members || []);
    setErrorPaymentTargets([]);
    setMemberNightConflicts([]);
  }

  function handleMemberNightConflict(data: {
    error?: string;
    conflicts?: BookingMemberNightConflict[];
  }) {
    setError(
      data.error ||
        "One or more members are already on a booking for these nights."
    );
    setMemberNightConflicts(data.conflicts || []);
    setGuestProfileBlocks([]);
    setErrorPaymentTargets([]);
  }

  function handleBookingApiError(data: Record<string, unknown>, fallback: string) {
    if (data.code === "GUEST_PROFILE_REQUIRED") {
      handleGuestProfileRequired(data as {
        error?: string;
        members?: GuestProfileRequiredMember[];
      });
      return;
    }
    if (data.code === "BOOKING_MEMBER_NIGHT_CONFLICT") {
      handleMemberNightConflict(data as {
        error?: string;
        conflicts?: BookingMemberNightConflict[];
      });
      return;
    }

    setGuestProfileBlocks([]);
    setMemberNightConflicts([]);
    setError(typeof data.error === "string" ? data.error : fallback);
    setErrorPaymentTargets(getBookingErrorPaymentTargets(data));
  }

  function formatConflictNights(nights: string[]) {
    if (nights.length === 0) return "the selected nights";
    if (nights.length === 1) return nights[0];
    if (nights.length === 2) return nights.join(" and ");
    return `${nights.length} nights`;
  }

  function formatConflictStatus(status: string) {
    return status.toLowerCase().split("_").join(" ");
  }

  async function handleRemoveConflictGuest(conflict: BookingMemberNightConflict) {
    setRemovingConflictGuestId(conflict.guestId);
    try {
      const res = await fetch(
        `/api/bookings/${conflict.bookingId}/guests/${conflict.guestId}`,
        { method: "DELETE" },
      );
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(
          typeof data.error === "string"
            ? data.error
            : "Failed to remove you from that booking.",
        );
        return;
      }

      const nextConflicts = memberNightConflicts.filter(
        (item) =>
          item.bookingId !== conflict.bookingId || item.guestId !== conflict.guestId,
      );
      setMemberNightConflicts(nextConflicts);
      setError(
        nextConflicts.length > 0
          ? "One or more members are already on a booking for these nights."
          : "",
      );

      if (nextConflicts.length === 0 && step !== "review") {
        void handleGuestsDone();
      }
    } catch {
      setError("Failed to remove you from that booking.");
    } finally {
      setRemovingConflictGuestId(null);
    }
  }

  async function handleDateSelect(ci: Date, co: Date) {
    setCheckIn(ci);
    setCheckOut(co);
    setError("");
    setGuestProfileBlocks([]);
    setMemberNightConflicts([]);
    setAppliedPromo(null);
    setPriceQuote(null);
    setUseCredit(false);
    setPerGuestDatesEnabled(false);
    setGuests((current) => clearGuestStayRanges(current));
    setActiveWorkPartyEvents([]);
    setWorkPartyError("");
    setWorkPartyClearedNotice(null);
    const ciStr = formatLocalDateOnly(ci);
    const coStr = formatLocalDateOnly(co);

    // Fetch availability for selected range
    const res = await fetch(
      `/api/availability/check?checkIn=${ciStr}&checkOut=${coStr}`
    );
    if (res.ok) {
      const data = await res.json();
      setAvailableBeds(data.minAvailable);
      setAvailabilityNightDetails(data.nightDetails || []);
    } else {
      setAvailabilityNightDetails([]);
    }

    // Check minimum stay policies
    const policyRes = await fetch(`/api/booking-policies/check?checkIn=${ciStr}&checkOut=${coStr}`);
    if (policyRes.ok) {
      const policyData = await policyRes.json();
      if (!policyData.valid) {
        setError(policyData.message);
        return;
      }
    }

    setStep("guests");
  }

  async function handleGuestsDone() {
    setGuestProfileBlocks([]);
    setMemberNightConflicts([]);
    if (guests.length === 0) {
      setError("Add at least one guest");
      return;
    }

    // Validate guest names
    for (const g of guests) {
      if (!g.firstName.trim() || !g.lastName.trim()) {
        setError("All guests must have first and last names");
        return;
      }
    }

    const guestPayload = buildGuestPayload();
    const stayRangeError = validateGuestStayRanges(guestPayload);
    if (stayRangeError) {
      setError(stayRangeError);
      return;
    }

    const fullNights = getCapacityExceededNights(guestPayload);
    if (fullNights.length > 0) {
      setError(formatCapacityExceededMessage(fullNights));
      return;
    }

    setError("");
    setMemberNightConflicts([]);
    setPriceLoading(true);

    // Fetch price quote
    const checkInStr = formatLocalDateOnly(checkIn!);
    const checkOutStr = formatLocalDateOnly(checkOut!);
    const res = await fetch("/api/bookings/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkIn: checkInStr,
        checkOut: checkOutStr,
        guests: guestPayload.map((g) => ({
          ageTier: g.ageTier,
          isMember: g.isMember,
          memberId: g.memberId,
          stayStart: g.stayStart,
          stayEnd: g.stayEnd,
          nights: g.nights,
        })),
      }),
    });

    if (res.ok) {
      const data = await res.json();
      setPriceQuote(data);
      setStep("review");

      // Fetch available promo codes for the member
      fetch("/api/promo-codes/available")
        .then((r) => {
          setPromoCodesEnabled(r.status !== 404);
          return r.ok ? r.json() : [];
        })
        .then((codes) => setAvailablePromoCodes(codes))
        .catch(() => {});

      // Fetch active working bee events that overlap these dates
      fetch(`/api/work-parties/active?checkIn=${checkInStr}&checkOut=${checkOutStr}`)
        .then((r) => r.ok ? r.json() : { events: [] })
        .then((data) => {
          const events: WorkPartyEvent[] = data.events || [];
          setActiveWorkPartyEvents(events);
          if (
            selectedWorkPartyEventId &&
            !events.some((e) => e.id === selectedWorkPartyEventId)
          ) {
            const previous = activeWorkPartyEvents.find(
              (e) => e.id === selectedWorkPartyEventId
            );
            setSelectedWorkPartyEventId(null);
            setAttendingWorkParty(false);
            if (previous) {
              setWorkPartyClearedNotice(previous.name);
            }
            setAppliedPromo((current) =>
              current?.workPartyEvent ? null : current
            );
          }
        })
        .catch(() => setActiveWorkPartyEvents([]));
    } else {
      const data = await res.json();
      handleBookingApiError(data, "Failed to calculate price");
    }
    setPriceLoading(false);
  }

  async function handleSubmit() {
    if (requiresAdminReviewLocal && !memberReviewJustification.trim()) {
      setError("Please add a reason for booking without an adult guest. This goes to an admin for review.");
      return;
    }
    const guestPayload = buildGuestPayload();
    const stayRangeError = validateGuestStayRanges(guestPayload);
    if (stayRangeError) {
      setError(stayRangeError);
      return;
    }
    setSubmitting(true);
    setError("");
    setErrorPaymentTargets([]);
    setGuestProfileBlocks([]);
    setMemberNightConflicts([]);
    setShowWaitlistPrompt(false);
    const checkInStr = formatLocalDateOnly(checkIn!);
    const checkOutStr = formatLocalDateOnly(checkOut!);

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkIn: checkInStr,
        checkOut: checkOutStr,
        guests: guestPayload,
        notes: notes || undefined,
        promoCode: appliedPromo?.code || undefined,
        promoGuestIndexes: appliedPromo?.selectedGuestIndexes,
        workPartyEventId: attendingWorkParty ? selectedWorkPartyEventId ?? undefined : undefined,
        expectedArrivalTime: expectedArrivalTime || undefined,
        requestedRoomId: requestedRoomId || undefined,
        cancelIfGuestsBumped:
          guests.some((g) => !g.isMember) && cancelIfGuestsBumped
            ? true
            : undefined,
        applyCreditCents: appliedCreditCents > 0 ? appliedCreditCents : undefined,
        paymentMethod:
          paymentMethod === "internet_banking" ? paymentMethod : undefined,
        memberReviewJustification: requiresAdminReviewLocal
          ? memberReviewJustification.trim()
          : undefined,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (groupTrip && groupBookingsEnabled) {
        // Best-effort: open the group so the share link is waiting on the
        // booking page. Bookings that aren't committed yet (e.g. non-member
        // holds in PENDING, or admin review) can't anchor a group, so tell
        // the member instead of silently dropping their choice; never block
        // the redirect.
        let groupOpened = false;
        try {
          const groupRes = await fetch("/api/group-bookings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              organiserBookingId: data.id,
              paymentMode: groupPaymentMode,
            }),
          });
          groupOpened = groupRes.ok;
        } catch {
          // fall through to the toast
        }
        if (!groupOpened) {
          toast.info(
            "Your group trip couldn't be opened yet. You can open it from your booking page once the booking is confirmed.",
          );
        }
      }
      // Card path: stay in the wizard and take payment as step 4 (#1084).
      // Everything else keeps the existing redirects: internet banking gets
      // its invoice instructions, holds/review/zero-due have nothing to pay.
      if (
        showPaymentMethodChoice &&
        paymentMethod === "stripe" &&
        isPaymentOwedBookingStatus(data.status)
      ) {
        setCreatedBooking({
          id: data.id,
          status: data.status,
          amountCents: remainingToPay,
          returnUrl: `${window.location.origin}/bookings/${data.id}`,
        });
        setStep("pay");
        setSubmitting(false);
        window.scrollTo({ top: 0 });
        return;
      }
      // Land on the payment card when payment is the next step; the hash is a
      // harmless no-op when the card isn't rendered (holds, review, zero due).
      router.push(
        showPaymentMethodChoice
          ? `/bookings/${data.id}#payment`
          : `/bookings/${data.id}`,
      );
    } else {
      const data = await res.json();
      if (data.code === "CAPACITY_EXCEEDED" && data.canWaitlist) {
        setShowWaitlistPrompt(true);
        setWaitlistFullNights(data.fullNights || []);
        setError("");
      } else {
        handleBookingApiError(data, "Failed to create booking");
      }
      setSubmitting(false);
    }
  }

  async function handleJoinWaitlist() {
    if (requiresAdminReviewLocal && !memberReviewJustification.trim()) {
      setError("Please add a reason for booking without an adult guest before joining the waitlist.");
      return;
    }
    const guestPayload = buildGuestPayload();
    const stayRangeError = validateGuestStayRanges(guestPayload);
    if (stayRangeError) {
      setError(stayRangeError);
      return;
    }
    setJoiningWaitlist(true);
    setError("");
    setErrorPaymentTargets([]);
    setGuestProfileBlocks([]);
    setMemberNightConflicts([]);
    const checkInStr = formatLocalDateOnly(checkIn!);
    const checkOutStr = formatLocalDateOnly(checkOut!);

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkIn: checkInStr,
        checkOut: checkOutStr,
        guests: guestPayload,
        notes: notes || undefined,
        promoCode: appliedPromo?.code || undefined,
        promoGuestIndexes: appliedPromo?.selectedGuestIndexes,
        workPartyEventId: attendingWorkParty ? selectedWorkPartyEventId ?? undefined : undefined,
        expectedArrivalTime: expectedArrivalTime || undefined,
        requestedRoomId: requestedRoomId || undefined,
        cancelIfGuestsBumped:
          guests.some((g) => !g.isMember) && cancelIfGuestsBumped
            ? true
            : undefined,
        waitlist: true,
        memberReviewJustification: requiresAdminReviewLocal
          ? memberReviewJustification.trim()
          : undefined,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      router.push(`/bookings/${data.id}`);
    } else {
      const data = await res.json();
      handleBookingApiError(data, "Failed to join waitlist");
      setJoiningWaitlist(false);
    }
  }

  async function handleSaveAsDraft() {
    const guestPayload = buildGuestPayload();
    const stayRangeError = validateGuestStayRanges(guestPayload);
    if (stayRangeError) {
      setError(stayRangeError);
      return;
    }
    setSavingDraft(true);
    setError("");
    setErrorPaymentTargets([]);
    setGuestProfileBlocks([]);
    setMemberNightConflicts([]);
    const checkInStr = formatLocalDateOnly(checkIn!);
    const checkOutStr = formatLocalDateOnly(checkOut!);

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkIn: checkInStr,
        checkOut: checkOutStr,
        guests: guestPayload,
        notes: notes || undefined,
        promoCode: appliedPromo?.code || undefined,
        promoGuestIndexes: appliedPromo?.selectedGuestIndexes,
        workPartyEventId: attendingWorkParty ? selectedWorkPartyEventId ?? undefined : undefined,
        expectedArrivalTime: expectedArrivalTime || undefined,
        requestedRoomId: requestedRoomId || undefined,
        cancelIfGuestsBumped:
          guests.some((g) => !g.isMember) && cancelIfGuestsBumped
            ? true
            : undefined,
        applyCreditCents: appliedCreditCents > 0 ? appliedCreditCents : undefined,
        draft: true,
        memberReviewJustification: requiresAdminReviewLocal
          ? memberReviewJustification.trim() || undefined
          : undefined,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (groupTrip && groupBookingsEnabled) {
        // Drafts can't anchor a group; tell the member where the option went.
        toast.info("You can open the group trip after confirming your booking.");
      }
      router.push(`/bookings/${data.id}`);
    } else {
      const data = await res.json();
      handleBookingApiError(data, "Failed to save draft");
      setSavingDraft(false);
    }
  }

  const nights = checkIn && checkOut
    ? Math.ceil((checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  function getGuestProfileBlockMessage(block: GuestProfileRequiredMember) {
    if (block.action === "own_login_required") {
      return `${block.name} has their own login and needs to sign in and confirm their details before they can be booked as a member.`;
    }

    if (block.action === "pending_admin_approval") {
      return "This family change is awaiting admin approval. You can add them as a non-member guest until approved.";
    }

    if (block.canCurrentUserResolve) {
      return `Complete ${block.name}'s details before booking them as a member.`;
    }

    return `${block.name}'s member details need to be completed or confirmed before they can be booked as a member.`;
  }

  function getGuestProfileActionLabel(block: GuestProfileRequiredMember) {
    if (block.action === "complete_details" && block.canCurrentUserResolve) {
      return "Complete details";
    }
    if (block.action === "own_login_required") {
      return "Ask them to sign in and confirm";
    }
    if (block.action === "pending_admin_approval") {
      return "Pending admin approval";
    }
    if (block.action === "contact_admin") {
      return "Contact admin";
    }
    return null;
  }

  const availableCreditCents = priceQuote?.availableCreditCents ?? 0;
  const finalPriceBeforeCredit = priceQuote
    ? (appliedPromo?.finalPriceCents ?? priceQuote.totalPriceCents)
    : 0;
  const appliedCreditCents = useCredit
    ? Math.min(availableCreditCents, finalPriceBeforeCredit)
    : 0;
  const remainingToPay = finalPriceBeforeCredit - appliedCreditCents;
  const bookingDateStrings = getBookingDateStrings();
  const reviewGuestPayload = priceQuote ? buildGuestPayload() : guests;
  const cardPaymentDescription =
    bookingMessages["booking.payment.card.description"] ??
    "Pay now and secure the booking immediately.";
  const internetBankingPaymentDescription =
    bookingMessages["booking.payment.internetBanking.description"] ??
    "Receive a Xero invoice by email and make payment via internet banking. Once the payment is reconciled and sync'd back to the booking system, your booking will be confirmed. Until then your booking is not held and someone else could take your space by booking and paying with Card.";
  const internetBankingUnavailableCopy =
    internetBankingUnavailableReason ??
    bookingMessages["booking.payment.internetBanking.unavailable"] ??
    "Internet Banking is not available for this check-in date. Please pay by card to secure the booking immediately.";

  const subscriptionUnpaid =
    subscriptionStatus &&
    (subscriptionStatus.status === "UNPAID" || subscriptionStatus.status === "OVERDUE");
  const showInviteFamilyGroupMembersLink =
    shouldShowInviteFamilyGroupMembersLink(familyMembers);
  const showPaymentMethodChoice =
    remainingToPay > 0 && !requiresAdminReviewLocal;

  useEffect(() => {
    if (
      paymentMethod === "internet_banking" &&
      (!internetBankingEnabled || remainingToPay <= 0 || requiresAdminReviewLocal)
    ) {
      setPaymentMethod("stripe");
    }
  }, [
    internetBankingEnabled,
    paymentMethod,
    remainingToPay,
    requiresAdminReviewLocal,
  ]);

  // Apply or refresh the working bee discount preview when a work party
  // event is selected (or the booking changes while one is selected).
  useEffect(() => {
    if (!selectedWorkPartyEventId || !checkIn || !checkOut || !priceQuote) {
      return;
    }

    let cancelled = false;
    setWorkPartyError("");

    fetch("/api/promo-codes/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workPartyEventId: selectedWorkPartyEventId,
        checkIn: formatLocalDateOnly(checkIn),
        checkOut: formatLocalDateOnly(checkOut),
        guests: reviewGuestPayload.map((g) => ({
          ageTier: g.ageTier,
          isMember: g.isMember,
          ...(g.memberId ? { memberId: g.memberId } : {}),
          ...(g.stayStart ? { stayStart: g.stayStart } : {}),
          ...(g.stayEnd ? { stayEnd: g.stayEnd } : {}),
        })),
      }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || data.valid === false) {
          setAppliedPromo(null);
          setWorkPartyError(data.error || "This working bee event could not be applied");
          return;
        }
        setAppliedPromo({
          code: data.code,
          description: data.description,
          type: data.type,
          discountCents: data.discountCents,
          promoAdjustmentCents: data.promoAdjustmentCents,
          totalPriceCents: data.totalPriceCents,
          finalPriceCents: data.finalPriceCents,
          workPartyEvent: data.workPartyEvent,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setAppliedPromo(null);
          setWorkPartyError("Failed to apply the working bee discount");
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkPartyEventId, checkIn, checkOut, priceQuote, JSON.stringify(reviewGuestPayload)]);

  const wizardSteps: Array<{ id: BookingWizardStep; label: string }> = [
    { id: "dates", label: "Select Dates" },
    { id: "guests", label: "Add Guests" },
    { id: "review", label: "Review & Confirm" },
    { id: "pay", label: requiresAdminReviewLocal ? "Admin Review" : "Pay" },
  ];
  const activeStepIndex = wizardSteps.findIndex((item) => item.id === step);

  return {
    step,
    setStep,
    createdBooking,
    checkIn,
    checkOut,
    guests,
    notes,
    setNotes,
    priceQuote,
    priceLoading,
    error,
    errorPaymentTargets,
    subscriptionInvoiceUrl,
    subscriptionInvoiceNumber,
    submitting,
    savingDraft,
    showWaitlistPrompt,
    setShowWaitlistPrompt,
    waitlistFullNights,
    joiningWaitlist,
    perGuestDatesEnabled,
    handlePerGuestDatesEnabledChange,
    multiDateRangesEnabled,
    handleMultiDateRangesEnabledChange,
    appliedPromo,
    setAppliedPromo,
    expectedArrivalTime,
    setExpectedArrivalTime,
    requestedRoomId,
    setRequestedRoomId,
    cancelIfGuestsBumped,
    setCancelIfGuestsBumped,
    roomOptions,
    roomRequestEnabled,
    useCredit,
    setUseCredit,
    paymentMethod,
    setPaymentMethod,
    internetBankingEnabled,
    groupBookingsEnabled,
    groupTrip,
    setGroupTrip,
    groupPaymentMode,
    setGroupPaymentMode,
    internetBankingUnavailableReason,
    internetBankingHoldSummary,
    familyMembers,
    subscriptionStatus,
    subscriptionLoading,
    availablePromoCodes,
    promoCodesEnabled,
    prefillPromoCode,
    setPrefillPromoCode,
    activeWorkPartyEvents,
    attendingWorkParty,
    setAttendingWorkParty,
    selectedWorkPartyEventId,
    setSelectedWorkPartyEventId,
    workPartyError,
    setWorkPartyError,
    workPartyClearedNotice,
    setWorkPartyClearedNotice,
    guestProfileBlocks,
    memberNightConflicts,
    removingConflictGuestId,
    memberReviewJustification,
    setMemberReviewJustification,
    requiresAdminReviewLocal,
    handleGuestsChange,
    addFamilyMemberAsGuest,
    handleRemoveConflictGuest,
    handleDateSelect,
    handleGuestsDone,
    handleSubmit,
    handleJoinWaitlist,
    handleSaveAsDraft,
    getGuestProfileBlockMessage,
    getGuestProfileActionLabel,
    formatConflictNights,
    formatConflictStatus,
    nights,
    availableCreditCents,
    appliedCreditCents,
    remainingToPay,
    bookingDateStrings,
    reviewGuestPayload,
    cardPaymentDescription,
    internetBankingPaymentDescription,
    internetBankingUnavailableCopy,
    subscriptionUnpaid,
    showInviteFamilyGroupMembersLink,
    showPaymentMethodChoice,
    wizardSteps,
    activeStepIndex,
    lodgeCapacity,
  };
}
