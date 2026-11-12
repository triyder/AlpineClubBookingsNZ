import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dateOnlyInstantOf, requireCalendarDate } from "@/lib/club-time";

import { fakeDb, resetFakeDb } from "./support/food-order-fake-db";

/**
 * Fork #121: the food-order member routes end to end over an in-memory
 * database — the access matrix for Received and price, creating an order, the
 * module gate, the Received claim under concurrent requests, price audit, and
 * the history's scope, filters, paging and totals.
 *
 * The REAL access module, service and route guard run; only Prisma, the
 * session, the module flags, the rate limiter, the clock reader and the mail
 * sender are replaced. Today is the frozen test day, 2026-07-01 (NZ).
 */

const mocks = vi.hoisted(() => ({
  modules: { foodOrders: true } as Record<string, boolean>,
  session: null as null | Record<string, unknown>,
  rateLimited: false,
  sendFoodOrderPlacedEmail: vi.fn(),
}));

vi.mock("@/lib/prisma", async () => ({
  prisma: (await import("./support/food-order-fake-db")).fakePrisma,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: async () => mocks.modules,
}));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: async () =>
    mocks.session
      ? { ok: true, session: { user: mocks.session } }
      : {
          ok: false,
          response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
        },
}));
vi.mock("@/lib/club-time/server", async () => {
  const clubTime = (await import("@/lib/club-time")) as typeof import("@/lib/club-time");
  const { CLUB_FORMAT_TEST } = (await import(
    "./support/club-format-fixture"
  )) as typeof import("./support/club-format-fixture");
  const bound = clubTime.bindClubTime(
    clubTime.requireClubTimeZone("Pacific/Auckland"),
    CLUB_FORMAT_TEST,
  );
  return {
    clubTime: async () => bound,
    clubTodayDateOnlyInstant: async () => clubTime.dateOnlyInstantOf(bound.today()),
  };
});
vi.mock("@/lib/rate-limit", () => ({
  rateLimiters: { foodOrderMember: { id: "food-order-member" } },
  applyMemberScopedRateLimit: async () =>
    mocks.rateLimited
      ? NextResponse.json({ error: "Too many requests" }, { status: 429 })
      : null,
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/email", () => ({
  sendFoodOrderPlacedEmail: mocks.sendFoodOrderPlacedEmail,
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET as historyGet } from "@/app/api/food-orders/history/route";
import { PATCH as pricePatch } from "@/app/api/food-orders/[id]/price/route";
import { POST as receivedPost } from "@/app/api/food-orders/[id]/received/route";
import { GET as formGet, POST as orderPost } from "@/app/api/food-orders/route";

const day = (value: string) => dateOnlyInstantOf(requireCalendarDate(value));

const NO_ACCESS = {
  overview: "none",
  bookings: "none",
  membership: "none",
  finance: "none",
  lodge: "none",
  content: "none",
  support: "none",
} as const;

function user(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    role: "USER",
    accessRoles: ["USER"],
    canLogin: true,
    adminPermissionMatrix: NO_ACCESS,
    ...overrides,
  };
}

const ROLES = {
  member: () => user("member-1"),
  owner: () => user("owner-1"),
  organisation: () => user("org-1", { accessRoles: ["ORG"] }),
  committee: () => {
    fakeDb.committee.push({ memberId: "committee-1", isActive: true, roleActive: true });
    return user("committee-1");
  },
  hutLeaderInWindow: () => {
    fakeDb.hutLeaders.push({
      memberId: "leader-1",
      lodgeId: "lodge-a",
      startDate: day("2026-07-01"),
      endDate: day("2026-07-04"),
    });
    return user("leader-1");
  },
  hutLeaderOutOfWindow: () => {
    fakeDb.hutLeaders.push({
      memberId: "leader-2",
      lodgeId: "lodge-a",
      startDate: day("2026-07-10"),
      endDate: day("2026-07-12"),
    });
    return user("leader-2");
  },
  hutLeaderOtherLodge: () => {
    fakeDb.hutLeaders.push({
      memberId: "leader-3",
      lodgeId: "lodge-b",
      startDate: day("2026-07-01"),
      endDate: day("2026-07-04"),
    });
    return user("leader-3");
  },
  lodgeViewAdmin: () =>
    user("admin-view", { adminPermissionMatrix: { ...NO_ACCESS, lodge: "view" } }),
  lodgeEditAdmin: () =>
    user("admin-edit", { adminPermissionMatrix: { ...NO_ACCESS, lodge: "edit" } }),
};

function seedOrder(overrides: Partial<(typeof fakeDb.orders)[number]> = {}) {
  const order = {
    id: `seed-${fakeDb.orders.length + 1}`,
    lodgeId: "lodge-a",
    memberId: "owner-1",
    neededBy: day("2026-07-05"),
    notes: null,
    status: "OPEN" as const,
    receivedAt: null,
    receivedById: null,
    priceCents: null,
    priceUpdatedAt: null,
    priceUpdatedById: null,
    createdAt: new Date(Date.UTC(2026, 5, 1 + fakeDb.orders.length)),
    items: [{ description: "Bread", quantity: 2, sortOrder: 0 }],
    ...overrides,
  };
  fakeDb.orders.push(order);
  return order;
}

function jsonRequest(url: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function receive(id: string) {
  return receivedPost(jsonRequest(`/api/food-orders/${id}/received`, "POST"), params(id));
}
function price(id: string, priceCents: unknown) {
  return pricePatch(
    jsonRequest(`/api/food-orders/${id}/price`, "PATCH", { priceCents }),
    params(id),
  );
}

const VALID_ORDER = {
  lodgeId: "lodge-a",
  neededBy: "2026-07-03",
  notes: "For the work party",
  items: [
    { description: "1 kg bags of flour", quantity: 3 },
    { description: "Dozen eggs", quantity: 2 },
    { description: "Coffee", quantity: 1 },
  ],
};
function placeOrder(body: unknown = VALID_ORDER) {
  return orderPost(jsonRequest("/api/food-orders", "POST", body));
}

beforeEach(() => {
  resetFakeDb();
  mocks.modules = { foodOrders: true };
  mocks.session = ROLES.member();
  mocks.rateLimited = false;
  mocks.sendFoodOrderPlacedEmail.mockReset();
  fakeDb.settings = { officerEmail: "food@club.test", officerLabel: "Food officer" };
});

describe("Received and price: the access matrix", () => {
  // [role, expected status for an order at lodge-a owned by owner-1]
  const matrix: Array<[keyof typeof ROLES, number]> = [
    ["member", 404],
    ["owner", 403],
    ["organisation", 403],
    ["committee", 200],
    ["hutLeaderInWindow", 200],
    ["hutLeaderOutOfWindow", 404],
    ["hutLeaderOtherLodge", 403],
    ["lodgeViewAdmin", 403],
    ["lodgeEditAdmin", 200],
  ];

  for (const [role, expected] of matrix) {
    it(`${role}: Received answers ${expected}`, async () => {
      const order = seedOrder();
      mocks.session = ROLES[role]();
      const res = await receive(order.id);
      expect(res.status).toBe(expected);
      expect(fakeDb.orders[0]?.status).toBe(expected === 200 ? "RECEIVED" : "OPEN");
    });

    it(`${role}: price answers ${expected}`, async () => {
      const order = seedOrder();
      mocks.session = ROLES[role]();
      const res = await price(order.id, 4250);
      expect(res.status).toBe(expected);
      expect(fakeDb.orders[0]?.priceCents).toBe(expected === 200 ? 4250 : null);
    });
  }

  it("signed out: 401 and nothing changes", async () => {
    const order = seedOrder();
    mocks.session = null;
    expect((await receive(order.id)).status).toBe(401);
    expect((await price(order.id, 100)).status).toBe(401);
    expect(fakeDb.orders[0]?.status).toBe("OPEN");
    expect(fakeDb.audit).toHaveLength(0);
  });

  it("an unknown order id answers 404", async () => {
    mocks.session = ROLES.lodgeEditAdmin();
    expect((await receive("missing")).status).toBe(404);
    expect((await price("missing", 100)).status).toBe(404);
  });
});

describe("the module gate", () => {
  it("module off: every route answers 404, signed in or not, and nothing is stored", async () => {
    const order = seedOrder();
    mocks.modules = { foodOrders: false };
    for (const session of [ROLES.lodgeEditAdmin(), null]) {
      mocks.session = session;
      expect((await formGet()).status).toBe(404);
      expect((await placeOrder()).status).toBe(404);
      expect(
        (await historyGet(jsonRequest("/api/food-orders/history", "GET"))).status,
      ).toBe(404);
      expect((await receive(order.id)).status).toBe(404);
      expect((await price(order.id, 100)).status).toBe(404);
    }
    expect(fakeDb.orders).toHaveLength(1);
    expect(fakeDb.orders[0]?.status).toBe("OPEN");
    expect(fakeDb.audit).toHaveLength(0);
  });
});

describe("placing an order", () => {
  it("stores it Open with every item, audits it, then emails the officer every item", async () => {
    const res = await placeOrder();
    expect(res.status).toBe(201);
    expect(fakeDb.orders).toHaveLength(1);
    const stored = fakeDb.orders[0]!;
    expect(stored.status).toBe("OPEN");
    expect(stored.memberId).toBe("member-1");
    expect(stored.neededBy.toISOString()).toBe("2026-07-03T00:00:00.000Z");
    expect(stored.items.map((item) => [item.description, item.quantity])).toEqual([
      ["1 kg bags of flour", 3],
      ["Dozen eggs", 2],
      ["Coffee", 1],
    ]);
    expect(fakeDb.audit.map((row) => row.action)).toEqual(["food_order.placed"]);

    await vi.waitFor(() => expect(mocks.sendFoodOrderPlacedEmail).toHaveBeenCalledOnce());
    const email = mocks.sendFoodOrderPlacedEmail.mock.calls[0]![0] as Record<string, unknown>;
    expect(email.to).toBe("food@club.test");
    expect(email.lodgeName).toBe("Lodge A");
    expect(email.notes).toBe("For the work party");
    expect(email.items).toEqual([
      { description: "1 kg bags of flour", quantity: 3 },
      { description: "Dozen eggs", quantity: 2 },
      { description: "Coffee", quantity: 1 },
    ]);
    expect(String(email.foodOrderUrl)).toContain(`/food-orders?order=${stored.id}`);
  });

  it("refuses with no officer email set, stores nothing and sends nothing", async () => {
    fakeDb.settings = { officerEmail: null, officerLabel: "Food officer" };
    const res = await placeOrder();
    expect(res.status).toBe(409);
    expect(fakeDb.orders).toHaveLength(0);
    expect(mocks.sendFoodOrderPlacedEmail).not.toHaveBeenCalled();

    const form = await (await formGet()).json();
    expect(form.ready).toBe(false);
  });

  it("reports ready, the label and the club's today to the form when set up", async () => {
    fakeDb.settings = { officerEmail: "food@club.test", officerLabel: "Catering officer" };
    const form = await (await formGet()).json();
    expect(form).toMatchObject({ ready: true, officerLabel: "Catering officer", today: "2026-07-01" });
    expect(JSON.stringify(form)).not.toContain("food@club.test");
  });

  const invalid: Array<[string, unknown]> = [
    ["no items", { ...VALID_ORDER, items: [] }],
    [
      "51 items",
      {
        ...VALID_ORDER,
        items: Array.from({ length: 51 }, (_, i) => ({ description: `Item ${i}`, quantity: 1 })),
      },
    ],
    ["an empty description", { ...VALID_ORDER, items: [{ description: "   ", quantity: 1 }] }],
    ["a 201-character description", { ...VALID_ORDER, items: [{ description: "x".repeat(201), quantity: 1 }] }],
    ["quantity 0", { ...VALID_ORDER, items: [{ description: "Milk", quantity: 0 }] }],
    ["quantity 1000", { ...VALID_ORDER, items: [{ description: "Milk", quantity: 1000 }] }],
    ["a fractional quantity", { ...VALID_ORDER, items: [{ description: "Milk", quantity: 1.5 }] }],
    ["yesterday as needed-by", { ...VALID_ORDER, neededBy: "2026-06-30" }],
    ["a malformed date", { ...VALID_ORDER, neededBy: "2026-13-01" }],
    ["an inactive or unknown lodge", { ...VALID_ORDER, lodgeId: "nowhere" }],
  ];
  for (const [label, body] of invalid) {
    it(`refuses ${label}`, async () => {
      const res = await placeOrder(body);
      expect(res.status).toBe(400);
      expect(fakeDb.orders).toHaveLength(0);
      expect(mocks.sendFoodOrderPlacedEmail).not.toHaveBeenCalled();
    });
  }

  it("accepts the boundaries: 50 items, quantities 1 and 999, and today as needed-by", async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      description: `Item ${i}`,
      quantity: i === 0 ? 999 : 1,
    }));
    const res = await placeOrder({ ...VALID_ORDER, neededBy: "2026-07-01", items });
    expect(res.status).toBe(201);
    expect(fakeDb.orders[0]?.items).toHaveLength(50);
  });

  it("is rate limited per member", async () => {
    mocks.rateLimited = true;
    expect((await placeOrder()).status).toBe(429);
    expect(fakeDb.orders).toHaveLength(0);
  });

  it("refuses an organisation account", async () => {
    mocks.session = ROLES.organisation();
    expect((await placeOrder()).status).toBe(403);
    expect((await formGet()).status).toBe(403);
    expect(fakeDb.orders).toHaveLength(0);
  });

  it("refuses a signed-out caller", async () => {
    mocks.session = null;
    expect((await placeOrder()).status).toBe(401);
  });
});

describe("closing an order", () => {
  it("two confirmations at once close it once, with one audit row", async () => {
    const order = seedOrder();
    mocks.session = ROLES.committee();
    const [first, second] = await Promise.all([receive(order.id), receive(order.id)]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(fakeDb.orders[0]?.status).toBe("RECEIVED");
    expect(fakeDb.orders[0]?.receivedById).toBe("committee-1");
    expect(fakeDb.audit.filter((row) => row.action === "food_order.received")).toHaveLength(1);
  });

  it("a closed order cannot be received again", async () => {
    const order = seedOrder({ status: "RECEIVED", receivedById: "x" });
    mocks.session = ROLES.lodgeEditAdmin();
    expect((await receive(order.id)).status).toBe(409);
    expect(fakeDb.orders[0]?.receivedById).toBe("x");
    expect(fakeDb.audit).toHaveLength(0);
  });
});

describe("recording the price", () => {
  it("audits every change with the old and new amounts, including on a closed order", async () => {
    const order = seedOrder({ status: "RECEIVED" });
    mocks.session = ROLES.hutLeaderInWindow();
    expect((await price(order.id, 4250)).status).toBe(200);
    expect((await price(order.id, 3999)).status).toBe(200);
    expect(fakeDb.orders[0]?.priceCents).toBe(3999);
    expect(fakeDb.orders[0]?.priceUpdatedById).toBe("leader-1");
    const rows = fakeDb.audit.filter((row) => row.action === "food_order.price_updated");
    expect(rows.map((row) => JSON.parse(row.details ?? "{}"))).toEqual([
      { fromCents: null, toCents: 4250 },
      { fromCents: 4250, toCents: 3999 },
    ]);
  });

  it("saving the same amount again writes no audit row", async () => {
    const order = seedOrder({ priceCents: 1000 });
    mocks.session = ROLES.committee();
    expect((await price(order.id, 1000)).status).toBe(200);
    expect(fakeDb.audit).toHaveLength(0);
  });

  const badPrices: unknown[] = [-1, 12.5, "1000", null, 2_147_483_648, Number.MAX_SAFE_INTEGER];
  for (const value of badPrices) {
    it(`refuses ${JSON.stringify(value)} as a price`, async () => {
      const order = seedOrder();
      mocks.session = ROLES.committee();
      expect((await price(order.id, value)).status).toBe(400);
      expect(fakeDb.orders[0]?.priceCents).toBeNull();
      expect(fakeDb.audit).toHaveLength(0);
    });
  }

  it("accepts zero cents", async () => {
    const order = seedOrder();
    mocks.session = ROLES.committee();
    expect((await price(order.id, 0)).status).toBe(200);
    expect(fakeDb.orders[0]?.priceCents).toBe(0);
  });
});

describe("the history", () => {
  async function history(query = "") {
    const res = await historyGet(jsonRequest(`/api/food-orders/history${query}`, "GET"));
    return { status: res.status, body: await res.json() };
  }

  beforeEach(() => {
    seedOrder({ memberId: "member-1", lodgeId: "lodge-a", neededBy: day("2026-07-05"), priceCents: 1000 });
    seedOrder({ memberId: "member-1", lodgeId: "lodge-b", neededBy: day("2026-08-01"), status: "RECEIVED", priceCents: 2500 });
    seedOrder({ memberId: "other-1", lodgeId: "lodge-a", neededBy: day("2026-07-10"), priceCents: 400 });
    seedOrder({ memberId: "other-2", lodgeId: "lodge-a", neededBy: day("2026-09-01") });
  });

  it("a member sees only their own orders and their totals, and may manage none", async () => {
    const { status, body } = await history();
    expect(status).toBe(200);
    expect(body.canViewAll).toBe(false);
    expect(body.orders).toHaveLength(2);
    expect(body.orders.every((row: { isOwn: boolean }) => row.isOwn)).toBe(true);
    expect(body.orders.every((row: { canManage: boolean }) => !row.canManage)).toBe(true);
    expect(body.orderCount).toBe(2);
    expect(body.priceTotalCents).toBe(3500);
  });

  it("a committee member sees every order, with the count and price total", async () => {
    mocks.session = ROLES.committee();
    const { body } = await history();
    expect(body.canViewAll).toBe(true);
    expect(body.orderCount).toBe(4);
    expect(body.pricedCount).toBe(3);
    expect(body.priceTotalCents).toBe(3900);
    expect(body.orders.every((row: { canManage: boolean }) => row.canManage)).toBe(true);
  });

  it("a hut leader sees every order but manages only their lodge's", async () => {
    mocks.session = ROLES.hutLeaderInWindow();
    const { body } = await history();
    expect(body.orderCount).toBe(4);
    for (const row of body.orders as Array<{ lodgeId: string; canManage: boolean }>) {
      expect(row.canManage).toBe(row.lodgeId === "lodge-a");
    }
  });

  it("filters by lodge, status and needed-by range, and totals the filter", async () => {
    mocks.session = ROLES.lodgeViewAdmin();
    expect((await history("?lodgeId=lodge-a")).body.orderCount).toBe(3);
    expect((await history("?status=RECEIVED")).body.orderCount).toBe(1);
    const ranged = await history("?lodgeId=lodge-a&from=2026-07-01&to=2026-07-31");
    expect(ranged.body.orderCount).toBe(2);
    expect(ranged.body.priceTotalCents).toBe(1400);
    expect(ranged.body.orders.every((row: { canManage: boolean }) => !row.canManage)).toBe(true);
  });

  it("refuses a malformed filter rather than widening it", async () => {
    mocks.session = ROLES.committee();
    expect((await history("?status=CLOSED")).status).toBe(400);
    expect((await history("?from=01/07/2026")).status).toBe(400);
    expect((await history("?page=0")).status).toBe(400);
  });

  it("pages 25 at a time, with the count and total across every page", async () => {
    for (let i = 0; i < 26; i += 1) {
      seedOrder({ memberId: "bulk", neededBy: day("2026-10-01"), priceCents: 100 });
    }
    mocks.session = ROLES.committee();
    const first = await history();
    const second = await history("?page=2");
    expect(first.body.orders).toHaveLength(25);
    expect(second.body.orders).toHaveLength(5);
    expect(second.body.page).toBe(2);
    expect(first.body.orderCount).toBe(30);
    expect(first.body.priceTotalCents).toBe(3900 + 2600);
  });

  it("refuses an organisation account", async () => {
    mocks.session = ROLES.organisation();
    expect((await history()).status).toBe(403);
  });
});
