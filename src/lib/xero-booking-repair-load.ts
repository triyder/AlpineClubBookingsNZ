// Scope-where construction and audit-data loading (bookings, links, operations)
// for the booking-vs-Xero repair tool. Extracted verbatim from
// xero-booking-repair.ts (#1208 item 2).
import { Prisma } from "@prisma/client";
import {
  bookingRepairSelect,
  xeroObjectLinkSelect,
  xeroOperationSelect,
  type BookingClassificationContext,
  type BookingXeroRepairScope,
  type XeroObjectLinkRecord,
  type XeroOperationRecord,
} from "./xero-booking-repair-types";
import type { RepairDependencies } from "./xero-booking-repair-deps";
import { addDays, makeLocalKey, startOfDay } from "./xero-booking-repair-utils";

function buildScopeWhere(scope: BookingXeroRepairScope): Prisma.BookingWhereInput {
  const and: Prisma.BookingWhereInput[] = [];

  if (scope.bookingId) {
    and.push({ id: scope.bookingId });
  }

  if (scope.from || scope.to) {
    const from = scope.from ? startOfDay(scope.from) : undefined;
    const toExclusive = scope.to ? addDays(startOfDay(scope.to), 1) : undefined;
    const range = {
      ...(from ? { gte: from } : {}),
      ...(toExclusive ? { lt: toExclusive } : {}),
    };

    and.push({
      OR: [
        { createdAt: range },
        { updatedAt: range },
        { checkIn: range },
        {
          modifications: {
            some: {
              createdAt: range,
            },
          },
        },
      ],
    });
  }

  if (scope.all || and.length === 0) {
    return and.length > 0 ? { AND: and } : {};
  }

  return { AND: and };
}

export async function loadAuditData(
  scope: BookingXeroRepairScope,
  deps: RepairDependencies
) {
  const bookings = await deps.prisma.booking.findMany({
    where: buildScopeWhere(scope),
    select: bookingRepairSelect,
    orderBy: [
      { createdAt: "asc" },
      { id: "asc" },
    ],
  });

  const paymentIds = bookings
    .map((booking) => booking.payment?.id)
    .filter((value): value is string => Boolean(value));
  const bookingIds = bookings.map((booking) => booking.id);
  const modificationIds = bookings.flatMap((booking) =>
    booking.modifications.map((modification) => modification.id)
  );

  const linkScopes: Prisma.XeroObjectLinkWhereInput[] = [];
  if (paymentIds.length > 0) {
    linkScopes.push({ localModel: "Payment", localId: { in: paymentIds } });
  }
  if (bookingIds.length > 0) {
    linkScopes.push({ localModel: "Booking", localId: { in: bookingIds } });
  }
  if (modificationIds.length > 0) {
    linkScopes.push({
      localModel: "BookingModification",
      localId: { in: modificationIds },
    });
  }

  const operationScopes: Prisma.XeroSyncOperationWhereInput[] = [];
  if (paymentIds.length > 0) {
    operationScopes.push({ localModel: "Payment", localId: { in: paymentIds } });
  }
  if (bookingIds.length > 0) {
    operationScopes.push({ localModel: "Booking", localId: { in: bookingIds } });
  }
  if (modificationIds.length > 0) {
    operationScopes.push({
      localModel: "BookingModification",
      localId: { in: modificationIds },
    });
  }

  const [links, operations] = await Promise.all([
    linkScopes.length > 0
      ? deps.prisma.xeroObjectLink.findMany({
          where: {
            active: true,
            OR: linkScopes,
          },
          select: xeroObjectLinkSelect,
          orderBy: [
            { updatedAt: "desc" },
            { createdAt: "desc" },
          ],
        })
      : Promise.resolve([] as XeroObjectLinkRecord[]),
    operationScopes.length > 0
      ? deps.prisma.xeroSyncOperation.findMany({
          where: {
            OR: operationScopes,
          },
          select: xeroOperationSelect,
          orderBy: [
            { updatedAt: "desc" },
            { createdAt: "desc" },
          ],
        })
      : Promise.resolve([] as XeroOperationRecord[]),
  ]);

  const linksByLocalKey = new Map<string, XeroObjectLinkRecord[]>();
  for (const link of links) {
    const key = makeLocalKey(link.localModel, link.localId);
    const list = linksByLocalKey.get(key) ?? [];
    list.push(link);
    linksByLocalKey.set(key, list);
  }

  const operationsByLocalKey = new Map<string, XeroOperationRecord[]>();
  for (const operation of operations) {
    if (!operation.localModel || !operation.localId) {
      continue;
    }
    const key = makeLocalKey(operation.localModel, operation.localId);
    const list = operationsByLocalKey.get(key) ?? [];
    list.push(operation);
    operationsByLocalKey.set(key, list);
  }

  return bookings.map<BookingClassificationContext>((booking) => ({
    booking,
    paymentLinks: booking.payment
      ? linksByLocalKey.get(makeLocalKey("Payment", booking.payment.id)) ?? []
      : [],
    bookingLinks: linksByLocalKey.get(makeLocalKey("Booking", booking.id)) ?? [],
    modificationLinksById: new Map(
      booking.modifications.map((modification) => [
        modification.id,
        linksByLocalKey.get(makeLocalKey("BookingModification", modification.id)) ?? [],
      ])
    ),
    paymentOperations: booking.payment
      ? operationsByLocalKey.get(makeLocalKey("Payment", booking.payment.id)) ?? []
      : [],
    bookingOperations: operationsByLocalKey.get(makeLocalKey("Booking", booking.id)) ?? [],
    modificationOperationsById: new Map(
      booking.modifications.map((modification) => [
        modification.id,
        operationsByLocalKey.get(makeLocalKey("BookingModification", modification.id)) ?? [],
      ])
    ),
  }));
}
