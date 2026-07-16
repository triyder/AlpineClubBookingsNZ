import { CreditType, Prisma } from "@prisma/client";
import { buildSyntheticAllocationLinkId } from "@/lib/xero-inbound/amounts";

const APPLIED_CREDIT_ALLOCATION_ROLE = "APPLIED_CREDIT_ALLOCATION";

type RepairDb = Prisma.TransactionClient;

export interface ProviderAppliedCreditTarget {
  xeroCreditNoteId: string;
  amountCents: number;
}

type Slice = {
  id: string;
  memberCreditId: string;
  xeroCreditNoteId: string;
  amountCents: number;
  createdAt: Date;
};

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function ensureAllocationProvenance(params: {
  db: RepairDb;
  slice: Slice;
  invoiceId: string;
  changed: boolean;
  allowMissing: boolean;
}) {
  const activeLinks = await params.db.xeroObjectLink.findMany({
    where: {
      localModel: "MemberCreditNoteAllocation",
      localId: params.slice.id,
      xeroObjectType: "ALLOCATION",
      role: APPLIED_CREDIT_ALLOCATION_ROLE,
      active: true,
    },
    select: { id: true, metadata: true },
  });

  if (!params.changed && activeLinks.length > 0) {
    for (const link of activeLinks) {
      const metadata = metadataRecord(link.metadata);
      const cents =
        typeof metadata?.rowTargetCents === "number"
          ? metadata.rowTargetCents
          : metadata?.amountCents;
      if (
        metadata?.creditNoteId !== params.slice.xeroCreditNoteId ||
        metadata?.invoiceId !== params.invoiceId ||
        cents !== params.slice.amountCents
      ) {
        throw new Error(
          `Applied-credit allocation slice ${params.slice.id} has mismatched active Xero provenance`,
        );
      }
    }
    return;
  }

  if (activeLinks.length === 0 && !params.allowMissing) {
    throw new Error(
      `Applied-credit allocation slice ${params.slice.id} has no active Xero provenance`,
    );
  }

  if (activeLinks.length > 0) {
    await params.db.xeroObjectLink.updateMany({
      where: { id: { in: activeLinks.map((link) => link.id) } },
      data: { active: false },
    });
  }

  if (params.slice.amountCents <= 0) return;
  const syntheticBaseId = buildSyntheticAllocationLinkId(
    params.slice.xeroCreditNoteId,
    params.invoiceId,
    params.slice.amountCents,
  );
  // Never reactivate a superseded synthetic link when a later manual edit
  // returns to an old amount: include the immediately superseded anchors in
  // the replacement identity so inactive provenance remains immutable history.
  const syntheticAllocationId =
    params.changed && activeLinks.length > 0
      ? `${syntheticBaseId}:after:${activeLinks
          .map((link) => link.id)
          .sort()
          .join(",")}`
      : syntheticBaseId;
  await params.db.xeroObjectLink.upsert({
    where: {
      localModel_localId_xeroObjectType_xeroObjectId_role: {
        localModel: "MemberCreditNoteAllocation",
        localId: params.slice.id,
        xeroObjectType: "ALLOCATION",
        xeroObjectId: syntheticAllocationId,
        role: APPLIED_CREDIT_ALLOCATION_ROLE,
      },
    },
    create: {
      localModel: "MemberCreditNoteAllocation",
      localId: params.slice.id,
      xeroObjectType: "ALLOCATION",
      xeroObjectId: syntheticAllocationId,
      role: APPLIED_CREDIT_ALLOCATION_ROLE,
      active: true,
      metadata: {
        creditNoteId: params.slice.xeroCreditNoteId,
        invoiceId: params.invoiceId,
        amountCents: params.slice.amountCents,
        rowTargetCents: params.slice.amountCents,
        repairedFromStampedMemberCredit: true,
        providerTargetReconciled: params.changed,
      },
    },
    update: {
      active: true,
      metadata: {
        creditNoteId: params.slice.xeroCreditNoteId,
        invoiceId: params.invoiceId,
        amountCents: params.slice.amountCents,
        rowTargetCents: params.slice.amountCents,
        repairedFromStampedMemberCredit: true,
        providerTargetReconciled: params.changed,
      },
    },
  });
}

async function findUniqueFundingLot(params: {
  db: RepairDb;
  memberId: string;
  xeroCreditNoteId: string;
}) {
  const lots = await params.db.memberCredit.findMany({
    where: {
      memberId: params.memberId,
      xeroCreditNoteId: params.xeroCreditNoteId,
      amountCents: { gt: 0 },
    },
    select: { id: true, amountCents: true },
    take: 2,
  });
  if (lots.length !== 1) {
    throw new Error(
      `Cannot repair applied credit note ${params.xeroCreditNoteId}: expected one positive funding lot, found ${lots.length}`,
    );
  }
  return lots[0];
}

async function assertSliceFitsFundingLot(params: {
  db: RepairDb;
  sliceId?: string;
  memberCreditId: string;
  fundingCents: number;
  targetCents: number;
  bookingId: string;
  xeroCreditNoteId: string;
}) {
  const allocated = await params.db.memberCreditNoteAllocation.aggregate({
    where: {
      memberCreditId: params.memberCreditId,
      ...(params.sliceId ? { id: { not: params.sliceId } } : {}),
    },
    _sum: { amountCents: true },
  });
  const remainingCents = Math.max(
    0,
    params.fundingCents - (allocated._sum.amountCents ?? 0),
  );
  if (params.targetCents > remainingCents) {
    throw new Error(
      `Cannot repair applied credit note ${params.xeroCreditNoteId} for booking ${params.bookingId}: applied ${params.targetCents}c exceeds remaining funding lot ${remainingCents}c`,
    );
  }
}

/**
 * Compatibility repair for inbound/legacy applied-credit rows that predate the
 * precise per-note slice ledger. Callers already hold the member-credit lock.
 *
 * Without a provider target this validates existing working slices against the
 * signed historical ledger. A positive clamp offset permits the still-provider-
 * allocated total to sit between the new net target and the historical negative
 * total until the durable deallocation converges. Any other mismatch fails
 * closed. With a provider target (only the inbound Xero path), one unambiguous
 * slice is reconciled to that observed amount while old links are deactivated,
 * preserving both ledger history and allocation-link history.
 */
export async function repairLegacyAppliedCreditNoteAllocationsForBooking(
  bookingId: string,
  invoiceId: string,
  db: RepairDb,
  options?: { providerTarget?: ProviderAppliedCreditTarget },
): Promise<number> {
  const appliedRows = await db.memberCredit.findMany({
    where: {
      appliedToBookingId: bookingId,
      type: CreditType.BOOKING_APPLIED,
    },
    select: {
      memberId: true,
      amountCents: true,
      xeroCreditNoteId: true,
    },
  });
  const memberIds = [...new Set(appliedRows.map((row) => row.memberId))];
  if (memberIds.length > 1) {
    throw new Error(`Applied credit for booking ${bookingId} spans multiple members`);
  }

  const negativeByNote = new Map<string, number>();
  for (const row of appliedRows) {
    if (row.amountCents >= 0 || !row.xeroCreditNoteId) continue;
    negativeByNote.set(
      row.xeroCreditNoteId,
      (negativeByNote.get(row.xeroCreditNoteId) ?? 0) + Math.abs(row.amountCents),
    );
  }
  const historicalNegativeCents = [...negativeByNote.values()].reduce(
    (sum, cents) => sum + cents,
    0,
  );
  const positiveOffsetCents = appliedRows
    .filter((row) => row.amountCents > 0)
    .reduce((sum, row) => sum + row.amountCents, 0);
  const desiredAppliedCents = Math.max(
    0,
    -appliedRows.reduce((sum, row) => sum + row.amountCents, 0),
  );

  let slices = (await db.memberCreditNoteAllocation.findMany({
    where: { appliedToBookingId: bookingId },
    select: {
      id: true,
      memberCreditId: true,
      xeroCreditNoteId: true,
      amountCents: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })) as Slice[];
  let created = 0;

  const providerTarget = options?.providerTarget;
  if (providerTarget) {
    if (!Number.isInteger(providerTarget.amountCents) || providerTarget.amountCents < 0) {
      throw new Error("Provider applied-credit target must be non-negative integer cents");
    }
    const noteSlices = slices.filter(
      (slice) => slice.xeroCreditNoteId === providerTarget.xeroCreditNoteId,
    );
    if (noteSlices.length > 1) {
      throw new Error(
        `Cannot reconcile provider target for ${providerTarget.xeroCreditNoteId}: ${noteSlices.length} local slices are ambiguous`,
      );
    }

    if (noteSlices.length === 0 && providerTarget.amountCents > 0) {
      const memberId = memberIds[0];
      if (!memberId) {
        throw new Error(
          `Cannot repair applied credit note ${providerTarget.xeroCreditNoteId}: no member ledger row proves ownership`,
        );
      }
      const lot = await findUniqueFundingLot({
        db,
        memberId,
        xeroCreditNoteId: providerTarget.xeroCreditNoteId,
      });
      await assertSliceFitsFundingLot({
        db,
        memberCreditId: lot.id,
        fundingCents: lot.amountCents,
        targetCents: providerTarget.amountCents,
        bookingId,
        xeroCreditNoteId: providerTarget.xeroCreditNoteId,
      });
      const allocation = await db.memberCreditNoteAllocation.create({
        data: {
          memberCreditId: lot.id,
          xeroCreditNoteId: providerTarget.xeroCreditNoteId,
          appliedToBookingId: bookingId,
          amountCents: providerTarget.amountCents,
        },
        select: { id: true, createdAt: true },
      });
      const slice: Slice = {
        id: allocation.id,
        memberCreditId: lot.id,
        xeroCreditNoteId: providerTarget.xeroCreditNoteId,
        amountCents: providerTarget.amountCents,
        createdAt: allocation.createdAt,
      };
      slices = [...slices, slice];
      await ensureAllocationProvenance({
        db,
        slice,
        invoiceId,
        changed: true,
        allowMissing: true,
      });
      created += 1;
    } else if (noteSlices.length === 1) {
      const current = noteSlices[0];
      const lot = await db.memberCredit.findUnique({
        where: { id: current.memberCreditId },
        select: { amountCents: true, memberId: true, xeroCreditNoteId: true },
      });
      if (
        !lot ||
        lot.memberId !== memberIds[0] ||
        lot.xeroCreditNoteId !== providerTarget.xeroCreditNoteId
      ) {
        throw new Error(
          `Applied-credit allocation slice ${current.id} has invalid funding provenance`,
        );
      }
      await assertSliceFitsFundingLot({
        db,
        sliceId: current.id,
        memberCreditId: current.memberCreditId,
        fundingCents: lot.amountCents,
        targetCents: providerTarget.amountCents,
        bookingId,
        xeroCreditNoteId: providerTarget.xeroCreditNoteId,
      });
      const changed = current.amountCents !== providerTarget.amountCents;
      if (changed && providerTarget.amountCents === 0) {
        await ensureAllocationProvenance({
          db,
          slice: { ...current, amountCents: 0 },
          invoiceId,
          changed: true,
          allowMissing: true,
        });
        await db.memberCreditNoteAllocation.delete({ where: { id: current.id } });
        slices = slices.filter((slice) => slice.id !== current.id);
      } else {
        const next = changed
          ? await db.memberCreditNoteAllocation.update({
              where: { id: current.id },
              data: { amountCents: providerTarget.amountCents },
              select: {
                id: true,
                memberCreditId: true,
                xeroCreditNoteId: true,
                amountCents: true,
                createdAt: true,
              },
            })
          : current;
        slices = slices.map((slice) => (slice.id === current.id ? next : slice));
        await ensureAllocationProvenance({
          db,
          slice: next,
          invoiceId,
          changed,
          allowMissing: true,
        });
      }
    }
    return created;
  }

  const existingTotal = slices.reduce((sum, slice) => sum + slice.amountCents, 0);
  if (slices.length > 0) {
    const upperBound = Math.max(historicalNegativeCents, desiredAppliedCents);
    if (
      existingTotal < desiredAppliedCents ||
      existingTotal > upperBound ||
      (positiveOffsetCents === 0 && existingTotal !== desiredAppliedCents)
    ) {
      throw new Error(
        `Existing applied-credit slices for booking ${bookingId} total ${existingTotal}c but ledger permits ${desiredAppliedCents}c..${upperBound}c`,
      );
    }
    for (const slice of slices) {
      await ensureAllocationProvenance({
        db,
        slice,
        invoiceId,
        changed: false,
        allowMissing: false,
      });
    }
    return 0;
  }

  // A fully deallocated booking retains its historical negative rows, positive
  // clamp offset, and inactive link/checkpoint history. Net zero is definitive:
  // recreating a working slice here would resurrect provider-released credit.
  if (desiredAppliedCents === 0) return 0;
  if (negativeByNote.size !== 1 || !memberIds[0]) {
    throw new Error(
      `Cannot repair applied credit for booking ${bookingId}: precise note provenance is ambiguous`,
    );
  }
  const [xeroCreditNoteId, amountCents] = [...negativeByNote.entries()][0];
  const lot = await findUniqueFundingLot({
    db,
    memberId: memberIds[0],
    xeroCreditNoteId,
  });
  await assertSliceFitsFundingLot({
    db,
    memberCreditId: lot.id,
    fundingCents: lot.amountCents,
    targetCents: amountCents,
    bookingId,
    xeroCreditNoteId,
  });
  const allocation = await db.memberCreditNoteAllocation.create({
    data: {
      memberCreditId: lot.id,
      xeroCreditNoteId,
      appliedToBookingId: bookingId,
      amountCents,
    },
    select: { id: true, createdAt: true },
  });
  await ensureAllocationProvenance({
    db,
    invoiceId,
    changed: false,
    allowMissing: true,
    slice: {
      id: allocation.id,
      memberCreditId: lot.id,
      xeroCreditNoteId,
      amountCents,
      createdAt: allocation.createdAt,
    },
  });
  return 1;
}
