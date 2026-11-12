/**
 * A small in-memory stand-in for the Prisma calls the food-order code makes
 * (fork #121), shared by the food-order route suites through `vi.mock`.
 *
 * It evaluates the where-clauses the production code builds — the
 * status-guarded `updateMany`, the price guard, the history filters, the
 * committee and hut-leader access-window reads — rather than returning canned
 * answers, so a guard that is dropped or widened changes what these fakes do.
 * `$transaction(fn)` runs `fn` against the same tables: enough for the order
 * of effects, not a model of PostgreSQL isolation.
 */

export type FakeFoodOrder = {
  id: string;
  lodgeId: string;
  memberId: string | null;
  neededBy: Date;
  notes: string | null;
  status: "OPEN" | "RECEIVED";
  receivedAt: Date | null;
  receivedById: string | null;
  priceCents: number | null;
  priceUpdatedAt: Date | null;
  priceUpdatedById: string | null;
  createdAt: Date;
  items: Array<{ description: string; quantity: number; sortOrder: number }>;
};

export const fakeDb = {
  orders: [] as FakeFoodOrder[],
  audit: [] as Array<{ action: string; details: string | null; memberId: string | null; entityId: string | null }>,
  committee: [] as Array<{ memberId: string; isActive: boolean; roleActive: boolean }>,
  hutLeaders: [] as Array<{ memberId: string; lodgeId: string; startDate: Date; endDate: Date }>,
  lodges: [
    { id: "lodge-a", name: "Lodge A", active: true, isDefault: true },
    { id: "lodge-b", name: "Lodge B", active: true, isDefault: false },
  ],
  members: [] as Array<{ id: string; firstName: string; lastName: string; email: string }>,
  settings: null as null | { officerEmail: string | null; officerLabel: string },
  nextId: 1,
};

export function resetFakeDb() {
  fakeDb.orders.length = 0;
  fakeDb.audit.length = 0;
  fakeDb.committee.length = 0;
  fakeDb.hutLeaders.length = 0;
  fakeDb.members.length = 0;
  fakeDb.settings = null;
  fakeDb.nextId = 1;
}

type Where = Record<string, unknown>;

function matchesOrder(order: FakeFoodOrder, where: Where): boolean {
  for (const [key, condition] of Object.entries(where)) {
    const value = (order as unknown as Record<string, unknown>)[key];
    if (key === "neededBy" && condition && typeof condition === "object") {
      const range = condition as { gte?: Date; lte?: Date };
      if (range.gte && order.neededBy.getTime() < range.gte.getTime()) return false;
      if (range.lte && order.neededBy.getTime() > range.lte.getTime()) return false;
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

function projectOrder(order: FakeFoodOrder) {
  const lodge = fakeDb.lodges.find((row) => row.id === order.lodgeId);
  const member = fakeDb.members.find((row) => row.id === order.memberId) ?? null;
  return {
    ...order,
    lodge: { name: lodge?.name ?? "" },
    member,
    items: [...order.items]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(({ description, quantity }) => ({ description, quantity })),
  };
}

const foodOrder = {
  create: async ({ data }: { data: Record<string, unknown> & { items: { create: FakeFoodOrder["items"] } } }) => {
    const id = `order-${fakeDb.nextId++}`;
    fakeDb.orders.push({
      id,
      lodgeId: data.lodgeId as string,
      memberId: data.memberId as string,
      neededBy: data.neededBy as Date,
      notes: (data.notes as string | null) ?? null,
      status: "OPEN",
      receivedAt: null,
      receivedById: null,
      priceCents: null,
      priceUpdatedAt: null,
      priceUpdatedById: null,
      createdAt: new Date(fakeDb.nextId * 1000),
      items: data.items.create,
    });
    return { id };
  },
  findUnique: async ({ where }: { where: { id: string } }) => {
    const order = fakeDb.orders.find((row) => row.id === where.id);
    return order ? projectOrder(order) : null;
  },
  updateMany: async ({ where, data }: { where: Where; data: Partial<FakeFoodOrder> }) => {
    const rows = fakeDb.orders.filter((row) => matchesOrder(row, where));
    for (const row of rows) Object.assign(row, data);
    return { count: rows.length };
  },
  findMany: async ({ where, skip = 0, take = 1000 }: { where: Where; skip?: number; take?: number }) =>
    fakeDb.orders
      .filter((row) => matchesOrder(row, where))
      .sort(
        (a, b) =>
          b.neededBy.getTime() - a.neededBy.getTime() ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      )
      .slice(skip, skip + take)
      .map(projectOrder),
  aggregate: async ({ where }: { where: Where }) => {
    const rows = fakeDb.orders.filter((row) => matchesOrder(row, where));
    const priced = rows.filter((row) => row.priceCents !== null);
    return {
      _count: { _all: rows.length, priceCents: priced.length },
      _sum: {
        priceCents: priced.length
          ? priced.reduce((sum, row) => sum + (row.priceCents ?? 0), 0)
          : null,
      },
    };
  },
};

export const fakePrisma = {
  foodOrder,
  auditLog: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      fakeDb.audit.push({
        action: data.action as string,
        details: (data.details as string | null) ?? null,
        memberId: (data.memberId as string | null) ?? null,
        entityId: (data.entityId as string | null) ?? null,
      });
      return { id: `audit-${fakeDb.audit.length}` };
    },
  },
  foodOrderSettings: {
    findUnique: async () => fakeDb.settings,
    upsert: async ({ update }: { update: { officerEmail: string | null; officerLabel: string } }) => {
      fakeDb.settings = {
        officerEmail: update.officerEmail,
        officerLabel: update.officerLabel,
      };
      return fakeDb.settings;
    },
  },
  lodge: {
    findMany: async () => fakeDb.lodges.map(({ id, name }) => ({ id, name })),
    findFirst: async ({ where }: { where: { id: string; active: boolean } }) => {
      const lodge = fakeDb.lodges.find(
        (row) => row.id === where.id && row.active === where.active,
      );
      return lodge ? { id: lodge.id } : null;
    },
  },
  member: {
    findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
      fakeDb.members.filter((row) => where.id.in.includes(row.id)),
  },
  committeeAssignment: {
    findFirst: async ({
      where,
    }: {
      where: { memberId: string; isActive: boolean; committeeRole: { isActive: boolean } };
    }) =>
      fakeDb.committee.some(
        (row) =>
          row.memberId === where.memberId &&
          row.isActive === where.isActive &&
          row.roleActive === where.committeeRole.isActive,
      )
        ? { id: "assignment" }
        : null,
  },
  hutLeaderAssignment: {
    findMany: async ({
      where,
    }: {
      where: { memberId: string; startDate: { lte: Date }; endDate: { gte: Date } };
    }) =>
      fakeDb.hutLeaders
        .filter(
          (row) =>
            row.memberId === where.memberId &&
            row.startDate.getTime() <= where.startDate.lte.getTime() &&
            row.endDate.getTime() >= where.endDate.gte.getTime(),
        )
        .map((row) => ({ lodgeId: row.lodgeId })),
  },
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakePrisma),
};
