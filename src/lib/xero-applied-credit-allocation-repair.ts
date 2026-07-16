import { CreditType, Prisma } from "@prisma/client";
import { buildSyntheticAllocationLinkId } from "@/lib/xero-inbound/amounts";

const APPLIED_CREDIT_ALLOCATION_ROLE = "APPLIED_CREDIT_ALLOCATION";

type RepairDb = Prisma.TransactionClient;

/**
 * Compatibility repair for inbound/legacy applied-credit rows that predate the
 * precise per-note slice ledger. Callers already hold the member/booking
 * advisory lock. Ambiguous funding fails closed: guessing a positive lot would
 * make a later provider deallocation release somebody else's credit.
 */
export async function repairLegacyAppliedCreditNoteAllocationsForBooking(
  bookingId: string,
  invoiceId: string,
  db: RepairDb,
): Promise<number> {
  const appliedRows = await db.memberCredit.findMany({
    where: {
      appliedToBookingId: bookingId,
      type: CreditType.BOOKING_APPLIED,
      amountCents: { lt: 0 },
      xeroCreditNoteId: { not: null },
    },
    select: {
      memberId: true,
      amountCents: true,
      xeroCreditNoteId: true,
    },
  });

  const byNote = new Map<
    string,
    { memberId: string; amountCents: number }
  >();
  for (const row of appliedRows) {
    if (!row.xeroCreditNoteId) continue;
    const current = byNote.get(row.xeroCreditNoteId);
    if (current && current.memberId !== row.memberId) {
      throw new Error(
        `Applied credit note ${row.xeroCreditNoteId} is stamped across multiple members`,
      );
    }
    byNote.set(row.xeroCreditNoteId, {
      memberId: row.memberId,
      amountCents: (current?.amountCents ?? 0) + Math.abs(row.amountCents),
    });
  }

  let created = 0;
  for (const [xeroCreditNoteId, applied] of byNote) {
    const existing = await db.memberCreditNoteAllocation.findFirst({
      where: { appliedToBookingId: bookingId, xeroCreditNoteId },
      select: { id: true },
    });
    if (existing) continue;

    const fundingLots = await db.memberCredit.findMany({
      where: {
        memberId: applied.memberId,
        xeroCreditNoteId,
        amountCents: { gt: 0 },
      },
      select: { id: true, amountCents: true },
      take: 2,
    });
    if (fundingLots.length !== 1) {
      throw new Error(
        `Cannot repair applied credit note ${xeroCreditNoteId} for booking ${bookingId}: expected one positive funding lot, found ${fundingLots.length}`,
      );
    }
    const lot = fundingLots[0];
    const alreadyAllocated = await db.memberCreditNoteAllocation.aggregate({
      where: { memberCreditId: lot.id },
      _sum: { amountCents: true },
    });
    const remainingCents = Math.max(
      0,
      lot.amountCents - (alreadyAllocated._sum.amountCents ?? 0),
    );
    if (applied.amountCents > remainingCents) {
      throw new Error(
        `Cannot repair applied credit note ${xeroCreditNoteId} for booking ${bookingId}: applied ${applied.amountCents}c exceeds remaining funding lot ${remainingCents}c`,
      );
    }

    const allocation = await db.memberCreditNoteAllocation.create({
      data: {
        memberCreditId: lot.id,
        xeroCreditNoteId,
        appliedToBookingId: bookingId,
        amountCents: applied.amountCents,
      },
      select: { id: true },
    });
    const syntheticAllocationId = buildSyntheticAllocationLinkId(
      xeroCreditNoteId,
      invoiceId,
      applied.amountCents,
    );
    await db.xeroObjectLink.upsert({
      where: {
        localModel_localId_xeroObjectType_xeroObjectId_role: {
          localModel: "MemberCreditNoteAllocation",
          localId: allocation.id,
          xeroObjectType: "ALLOCATION",
          xeroObjectId: syntheticAllocationId,
          role: APPLIED_CREDIT_ALLOCATION_ROLE,
        },
      },
      create: {
        localModel: "MemberCreditNoteAllocation",
        localId: allocation.id,
        xeroObjectType: "ALLOCATION",
        xeroObjectId: syntheticAllocationId,
        role: APPLIED_CREDIT_ALLOCATION_ROLE,
        active: true,
        metadata: {
          creditNoteId: xeroCreditNoteId,
          invoiceId,
          amountCents: applied.amountCents,
          rowTargetCents: applied.amountCents,
          repairedFromStampedMemberCredit: true,
        },
      },
      update: { active: true },
    });
    created += 1;
  }
  return created;
}
