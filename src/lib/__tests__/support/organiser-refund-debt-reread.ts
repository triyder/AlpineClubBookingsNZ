/**
 * #4057: the answers an organiser child's edit refund debt can give after the
 * edit commits - the door's lookup of it by the edit's key, then the re-read by
 * id once `runOrganiserChildRefundDebtNow` has run it - and what the "Booking
 * Modified" email must then say. Shared by the four edit doors' tests so each
 * door is driven through the same states. `runs` is whether the debt is run at
 * all: a lookup that throws leaves nothing to run, and the debt stays owed.
 *
 * `primeOrganiserRefundDebt` answers a `paymentRecoveryOperation.findUnique`
 * double: the lookup by the edit's key finds the debt (or throws), and the
 * re-read by id gives the state's answer. Every other lookup answers null.
 */
import { PaymentRecoveryOperationStatus } from "@prisma/client";
import type { Mock } from "vitest";

import type { BookingModifiedRefundDestination } from "@/lib/booking-modified-email-copy";
import { buildOrganiserChildModificationRefundKey } from "@/lib/payment-recovery-keys";

type Reread = { status: PaymentRecoveryOperationStatus } | null | Error;

export const ORGANISER_REFUND_DEBT_STATES: ReadonlyArray<{
  label: string;
  lookupThrows: boolean;
  reread: Reread;
  runs: boolean;
  destination: BookingModifiedRefundDestination;
}> = [
  { label: "SUCCEEDED", lookupThrows: false, reread: { status: PaymentRecoveryOperationStatus.SUCCEEDED }, runs: true, destination: "organiser_card" },
  { label: "PENDING", lookupThrows: false, reread: { status: PaymentRecoveryOperationStatus.PENDING }, runs: true, destination: "organiser_card_pending" },
  { label: "FAILED", lookupThrows: false, reread: { status: PaymentRecoveryOperationStatus.FAILED }, runs: true, destination: "organiser_card_pending" },
  { label: "null (no row on the re-read)", lookupThrows: false, reread: null, runs: true, destination: "organiser_card_pending" },
  { label: "a re-read that throws", lookupThrows: false, reread: new Error("database blip on the re-read"), runs: true, destination: "organiser_card_pending" },
  { label: "the lookup throws", lookupThrows: true, reread: { status: PaymentRecoveryOperationStatus.SUCCEEDED }, runs: false, destination: "organiser_card_pending" },
];

export function primeOrganiserRefundDebt(
  findUnique: Mock,
  { bookingModificationId, debtId, lookupThrows, reread }: { bookingModificationId: string; debtId: string; lookupThrows: boolean; reread: Reread },
): void {
  const key = buildOrganiserChildModificationRefundKey(bookingModificationId);
  findUnique.mockImplementation(async (args: { where?: { idempotencyKey?: string; id?: string } }) => {
    if (args?.where?.idempotencyKey === key) {
      if (lookupThrows) throw new Error("database blip on the lookup");
      return { id: debtId };
    }
    if (args?.where?.id === debtId) {
      if (reread instanceof Error) throw reread;
      return reread;
    }
    return null;
  });
}
