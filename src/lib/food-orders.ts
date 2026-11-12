import type { FoodOrderStatus, Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import type { FoodOrderItemInput } from "@/lib/food-order-rules";
import { FOOD_ORDER_HISTORY_PAGE_SIZE } from "@/lib/food-order-rules";
import {
  canManageFoodOrder,
  canViewAllFoodOrders,
  type FoodOrderViewer,
} from "@/lib/food-order-access";
import { prisma } from "@/lib/prisma";

/**
 * The food-order service (fork #121): create, close, price and list.
 *
 * NO MONEY MOVES HERE. `priceCents` is a historical record for forecasting
 * (owner decisions 8 and 11). Nothing in this module charges a member, touches a
 * booking, an invoice, the booking ledger, member money or Xero, and nothing
 * here takes an advisory lock: food orders share no row, key or counterpart
 * writer with any booking, capacity or settlement path.
 *
 * Every write commits its audit row in the SAME transaction as the change it
 * records, so an order, a close or a price change can never land unaudited, and
 * a lost race writes neither.
 */

type AuditContext = { ipAddress: string };

/** The order and its item lines, and its audit row, in one transaction. */
export async function createFoodOrder(
  input: {
    memberId: string;
    lodgeId: string;
    /** The club calendar day, as a `@db.Date` instant (`dateOnlyInstantOf`). */
    neededBy: Date;
    notes: string | null;
    items: readonly FoodOrderItemInput[];
  },
  context: AuditContext,
): Promise<{ id: string }> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.foodOrder.create({
      data: {
        lodgeId: input.lodgeId,
        memberId: input.memberId,
        neededBy: input.neededBy,
        notes: input.notes,
        items: {
          create: input.items.map((item, index) => ({
            description: item.description.trim(),
            quantity: item.quantity,
            sortOrder: index,
          })),
        },
      },
      select: { id: true },
    });

    await createAuditLog(
      {
        action: "food_order.placed",
        // `lodge`: the affected domain is the physical lodge's supplies, like a
        // maintenance report (#2581's rule is the domain, not the actor).
        category: "lodge",
        memberId: input.memberId,
        targetId: order.id,
        entityType: "FoodOrder",
        entityId: order.id,
        details: JSON.stringify({
          lodgeId: input.lodgeId,
          itemCount: input.items.length,
        }),
        ipAddress: context.ipAddress,
        outcome: "success",
      },
      tx,
    );

    return order;
  });
}

export type FoodOrderClaimOutcome = "received" | "already_received";

/**
 * Close an OPEN order as RECEIVED. The claim is a status-guarded `updateMany`
 * (`OPEN` -> `RECEIVED`): of two confirmations at once exactly one matches the
 * row, and the loser changes nothing and writes no audit row.
 */
export async function markFoodOrderReceived(
  orderId: string,
  actorId: string,
  context: AuditContext,
): Promise<FoodOrderClaimOutcome> {
  return prisma.$transaction(async (tx) => {
    const receivedAt = new Date();
    const claim = await tx.foodOrder.updateMany({
      where: { id: orderId, status: "OPEN" },
      data: { status: "RECEIVED", receivedAt, receivedById: actorId },
    });
    if (claim.count === 0) return "already_received";

    await createAuditLog(
      {
        action: "food_order.received",
        category: "lodge",
        memberId: actorId,
        targetId: orderId,
        entityType: "FoodOrder",
        entityId: orderId,
        details: JSON.stringify({ from: "OPEN", to: "RECEIVED" }),
        ipAddress: context.ipAddress,
        outcome: "success",
      },
      tx,
    );
    return "received";
  });
}

export type FoodOrderPriceOutcome =
  | { outcome: "updated"; fromCents: number | null; toCents: number }
  | { outcome: "unchanged"; cents: number }
  | { outcome: "conflict" };

/**
 * Record or change an order's price, open or closed. Guarded on the price the
 * caller read, so the audit row's old amount is the one actually replaced: if
 * somebody else changed it in between, nothing is written and the caller is
 * told to reload. Saving the same amount again writes nothing either.
 */
export async function setFoodOrderPrice(
  input: {
    orderId: string;
    actorId: string;
    expectedCents: number | null;
    priceCents: number;
  },
  context: AuditContext,
): Promise<FoodOrderPriceOutcome> {
  if (input.expectedCents === input.priceCents) {
    return { outcome: "unchanged", cents: input.priceCents };
  }
  return prisma.$transaction(async (tx) => {
    const claim = await tx.foodOrder.updateMany({
      where: { id: input.orderId, priceCents: input.expectedCents },
      data: {
        priceCents: input.priceCents,
        priceUpdatedAt: new Date(),
        priceUpdatedById: input.actorId,
      },
    });
    if (claim.count === 0) return { outcome: "conflict" as const };

    await createAuditLog(
      {
        action: "food_order.price_updated",
        category: "lodge",
        memberId: input.actorId,
        targetId: input.orderId,
        entityType: "FoodOrder",
        entityId: input.orderId,
        // The old and new amounts in integer cents (issue item 3). A record
        // only: no charge, invoice, ledger row or Xero call follows.
        details: JSON.stringify({
          fromCents: input.expectedCents,
          toCents: input.priceCents,
        }),
        ipAddress: context.ipAddress,
        outcome: "success",
      },
      tx,
    );
    return {
      outcome: "updated" as const,
      fromCents: input.expectedCents,
      toCents: input.priceCents,
    };
  });
}

export type FoodOrderHistoryFilters = {
  lodgeId?: string;
  status?: FoodOrderStatus;
  /** Inclusive needed-by range, as `@db.Date` instants. */
  neededFrom?: Date;
  neededTo?: Date;
  page: number;
};

export type FoodOrderHistoryRow = {
  id: string;
  lodgeId: string;
  lodgeName: string;
  orderedBy: string | null;
  isOwn: boolean;
  neededBy: Date;
  notes: string | null;
  status: FoodOrderStatus;
  items: Array<{ description: string; quantity: number }>;
  receivedAt: Date | null;
  receivedBy: string | null;
  priceCents: number | null;
  priceUpdatedAt: Date | null;
  priceUpdatedBy: string | null;
  createdAt: Date;
  /** From `canManageFoodOrder`: the UI shows Received and price controls by it. */
  canManage: boolean;
};

export type FoodOrderHistory = {
  canViewAll: boolean;
  orders: FoodOrderHistoryRow[];
  page: number;
  pageSize: number;
  /** Orders matching the filter, across every page. */
  orderCount: number;
  /** Orders in the filter that have a price recorded. */
  pricedCount: number;
  /** The sum of recorded prices across the filter, in cents. */
  priceTotalCents: number;
};

function memberName(member: { firstName: string; lastName: string } | null | undefined) {
  if (!member) return null;
  return `${member.firstName} ${member.lastName}`.trim() || null;
}

/**
 * The history the viewer may see: their own orders, or every order when
 * `canViewAllFoodOrders`. The count and the price total cover the whole filter,
 * not just the page — they are the figures forecasting needs.
 */
export async function listFoodOrderHistory(
  viewer: FoodOrderViewer,
  filters: FoodOrderHistoryFilters,
): Promise<FoodOrderHistory> {
  const canViewAll = canViewAllFoodOrders(viewer);
  const neededBy: Prisma.DateTimeFilter = {};
  if (filters.neededFrom) neededBy.gte = filters.neededFrom;
  if (filters.neededTo) neededBy.lte = filters.neededTo;

  const where: Prisma.FoodOrderWhereInput = {
    ...(canViewAll ? {} : { memberId: viewer.memberId }),
    ...(filters.lodgeId ? { lodgeId: filters.lodgeId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.neededFrom || filters.neededTo ? { neededBy } : {}),
  };
  const page = Math.max(1, Math.trunc(filters.page));

  const [rows, totals] = await Promise.all([
    prisma.foodOrder.findMany({
      where,
      orderBy: [{ neededBy: "desc" }, { createdAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * FOOD_ORDER_HISTORY_PAGE_SIZE,
      take: FOOD_ORDER_HISTORY_PAGE_SIZE,
      select: {
        id: true,
        lodgeId: true,
        memberId: true,
        neededBy: true,
        notes: true,
        status: true,
        receivedAt: true,
        receivedById: true,
        priceCents: true,
        priceUpdatedAt: true,
        priceUpdatedById: true,
        createdAt: true,
        lodge: { select: { name: true } },
        member: { select: { firstName: true, lastName: true } },
        items: {
          orderBy: { sortOrder: "asc" },
          select: { description: true, quantity: true },
        },
      },
    }),
    prisma.foodOrder.aggregate({
      where,
      _count: { _all: true, priceCents: true },
      _sum: { priceCents: true },
    }),
  ]);

  // receivedById / priceUpdatedById are snapshot ids, not relations, so their
  // names are read in one batch for the page.
  const actorIds = [
    ...new Set(
      rows.flatMap((row) =>
        [row.receivedById, row.priceUpdatedById].filter(
          (id): id is string => typeof id === "string",
        ),
      ),
    ),
  ];
  const actors = actorIds.length
    ? await prisma.member.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const actorName = new Map(actors.map((actor) => [actor.id, memberName(actor)]));

  return {
    canViewAll,
    page,
    pageSize: FOOD_ORDER_HISTORY_PAGE_SIZE,
    orderCount: totals._count._all,
    pricedCount: totals._count.priceCents,
    priceTotalCents: totals._sum.priceCents ?? 0,
    orders: rows.map((row) => ({
      id: row.id,
      lodgeId: row.lodgeId,
      lodgeName: row.lodge.name,
      orderedBy: memberName(row.member),
      isOwn: row.memberId === viewer.memberId,
      neededBy: row.neededBy,
      notes: row.notes,
      status: row.status,
      items: row.items,
      receivedAt: row.receivedAt,
      receivedBy: row.receivedById ? (actorName.get(row.receivedById) ?? null) : null,
      priceCents: row.priceCents,
      priceUpdatedAt: row.priceUpdatedAt,
      priceUpdatedBy: row.priceUpdatedById
        ? (actorName.get(row.priceUpdatedById) ?? null)
        : null,
      createdAt: row.createdAt,
      canManage: canManageFoodOrder(viewer, row),
    })),
  };
}

/** The fields the action routes need to decide and act on one order. */
export async function findFoodOrderForAction(orderId: string) {
  return prisma.foodOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      lodgeId: true,
      memberId: true,
      status: true,
      priceCents: true,
    },
  });
}
