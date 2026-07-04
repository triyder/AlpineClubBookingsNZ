import type { AgeTier } from "@prisma/client";
import { buildProfilePathWithReturnTo } from "@/lib/internal-return-path";

export interface FamilyMember {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  relationship: "self" | "partner" | "dependent";
  canLogin?: boolean;
  canBeBooked?: boolean;
  missingFields?: string[];
  needsOwnLoginConfirmation?: boolean;
  canCurrentUserConfirmDetails?: boolean;
  pendingRequestStatus?: string | null;
  pendingRequests?: Array<{
    id: string;
    type: string;
    status: string;
    familyGroupId: string;
  }>;
  pendingRequestFamilyGroupIds?: string[];
  bookableFamilyGroupIds?: string[];
  action?:
    | "complete_details"
    | "own_login_required"
    | "pending_admin_approval"
    | "contact_admin"
    | null;
}

export interface RoomOption {
  id: string;
  name: string;
  bedCount: number;
}

export interface PriceQuote {
  guests: {
    ageTier: string;
    isMember: boolean;
    nights: number;
    priceCents: number;
    perNightCents?: number[];
    nightDates?: string[];
  }[];
  totalPriceCents: number;
  availableCreditCents?: number;
}

export interface WorkPartyEvent {
  id: string;
  name: string;
  description: string | null;
  startDate: string;
  endDate: string;
  discountPercent: number;
}

export type BookingPaymentMethod = "stripe" | "internet_banking";

export type BookingWizardStep = "dates" | "guests" | "review" | "pay";

export type GroupPaymentMode = "EACH_PAYS_OWN" | "ORGANISER_PAYS";

export interface CreatedBooking {
  id: string;
  status: string;
  amountCents: number;
  returnUrl: string;
}

export interface AvailablePromoCode {
  code: string;
  description: string | null;
  type: string;
  percentOff: number | null;
  valueCents: number | null;
  freeNightsPerIndividual: number | null;
  lifetimeFreeNightsCap: number | null;
  fixedNightlyPriceCents: number | null;
  fixedNightlyMode: string | null;
}

export const PROFILE_FAMILY_GROUP_RETURN_TO_BOOK = buildProfilePathWithReturnTo(
  "/book",
  "family-group",
);
