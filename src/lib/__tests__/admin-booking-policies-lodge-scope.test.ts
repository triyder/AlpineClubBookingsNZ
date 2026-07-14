import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Per-lodge policy override partitions (ADR-001 resolved question 3): the
// admin routes edit exactly one partition — null lodgeId (club-wide) or one
// lodge's override set — and must never cross partitions.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  cancellationFindMany: vi.fn(),
  cancellationDeleteMany: vi.fn(),
  cancellationCreateMany: vi.fn(),
  bookingDefaultsFindUnique: vi.fn(),
  bookingDefaultsUpsert: vi.fn(),
  minimumStayFindMany: vi.fn(),
  minimumStayCreate: vi.fn(),
  bookingPeriodFindMany: vi.fn(),
  bookingPeriodCreate: vi.fn(),
  bookingPeriodFindUnique: vi.fn(),
  bookingPeriodUpdate: vi.fn(),
  lodgeFindUnique: vi.fn(),
  logAudit: vi.fn(),
  transaction: vi.fn(),
  revalidatePublicPageContent: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: vi.fn(async () => null),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: mocks.revalidatePublicPageContent,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn() },
    cancellationPolicy: {
      findMany: mocks.cancellationFindMany,
    },
    bookingDefaults: {
      findUnique: mocks.bookingDefaultsFindUnique,
    },
    minimumStayPolicy: {
      findMany: mocks.minimumStayFindMany,
      create: mocks.minimumStayCreate,
    },
    bookingPeriod: {
      findMany: mocks.bookingPeriodFindMany,
      findUnique: mocks.bookingPeriodFindUnique,
      create: mocks.bookingPeriodCreate,
      update: mocks.bookingPeriodUpdate,
    },
    lodge: {
      findUnique: mocks.lodgeFindUnique,
    },
    $transaction: mocks.transaction,
  },
}));

import { GET as CANCELLATION_GET, PUT as CANCELLATION_PUT } from "@/app/api/admin/booking-policies/cancellation/route";
import { GET as MIN_STAY_GET, POST as MIN_STAY_POST } from "@/app/api/admin/booking-policies/minimum-stay/route";
import { GET as PERIODS_GET, POST as PERIODS_POST } from "@/app/api/admin/booking-policies/periods/route";
import { PUT as PERIOD_PUT } from "@/app/api/admin/booking-policies/periods/[id]/route";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};

const RULE = { daysBeforeStay: 7, refundPercentage: 50 };

function request(url: string, method = "GET", body?: unknown) {
  return new NextRequest(url, {
    method,
    ...(body !== undefined
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
}

function installTransactionMock() {
  mocks.transaction.mockImplementation(async (callback) =>
    callback({
      cancellationPolicy: {
        deleteMany: mocks.cancellationDeleteMany,
        createMany: mocks.cancellationCreateMany,
        findMany: mocks.cancellationFindMany,
      },
      bookingDefaults: {
        findUnique: mocks.bookingDefaultsFindUnique,
        upsert: mocks.bookingDefaultsUpsert,
      },
    }),
  );
}

describe("cancellation policy partitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.cancellationFindMany.mockResolvedValue([]);
    mocks.bookingDefaultsFindUnique.mockResolvedValue({ nonMemberHoldDays: 7 });
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });
    installTransactionMock();
  });

  it("GET reads the club-wide (null) partition by default", async () => {
    const res = await CANCELLATION_GET(
      request("http://localhost/api/admin/booking-policies/cancellation"),
    );

    expect(res.status).toBe(200);
    expect(mocks.cancellationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lodgeId: null } }),
    );
  });

  it("GET reads exactly one lodge's partition, never null-tolerant", async () => {
    await CANCELLATION_GET(
      request(
        "http://localhost/api/admin/booking-policies/cancellation?lodgeId=lodge-2",
      ),
    );

    expect(mocks.cancellationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lodgeId: "lodge-2" } }),
    );
  });

  it("club-wide PUT replaces only the null partition", async () => {
    const res = await CANCELLATION_PUT(
      request(
        "http://localhost/api/admin/booking-policies/cancellation",
        "PUT",
        { rules: [RULE], nonMemberHoldDays: 7 },
      ),
    );

    expect(res.status).toBe(200);
    expect(mocks.cancellationDeleteMany).toHaveBeenCalledWith({
      where: { lodgeId: null },
    });
    expect(mocks.cancellationCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ daysBeforeStay: 7, lodgeId: null })],
    });
  });

  it("lodge PUT replaces only that lodge's partition", async () => {
    const res = await CANCELLATION_PUT(
      request(
        "http://localhost/api/admin/booking-policies/cancellation",
        "PUT",
        { rules: [RULE], lodgeId: "lodge-2" },
      ),
    );

    expect(res.status).toBe(200);
    expect(mocks.cancellationDeleteMany).toHaveBeenCalledWith({
      where: { lodgeId: "lodge-2" },
    });
    expect(mocks.cancellationCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ daysBeforeStay: 7, lodgeId: "lodge-2" }),
      ],
    });
  });

  it("lodge PUT with empty rules removes the override", async () => {
    const res = await CANCELLATION_PUT(
      request(
        "http://localhost/api/admin/booking-policies/cancellation",
        "PUT",
        { rules: [], lodgeId: "lodge-2" },
      ),
    );

    expect(res.status).toBe(200);
    expect(mocks.cancellationDeleteMany).toHaveBeenCalledWith({
      where: { lodgeId: "lodge-2" },
    });
    expect(mocks.cancellationCreateMany).toHaveBeenCalledWith({ data: [] });
  });

  it("club-wide PUT with empty rules is rejected", async () => {
    const res = await CANCELLATION_PUT(
      request(
        "http://localhost/api/admin/booking-policies/cancellation",
        "PUT",
        { rules: [] },
      ),
    );

    expect(res.status).toBe(400);
    expect(mocks.cancellationDeleteMany).not.toHaveBeenCalled();
  });

  it("rejects per-lodge hold days (they are club-wide)", async () => {
    const res = await CANCELLATION_PUT(
      request(
        "http://localhost/api/admin/booking-policies/cancellation",
        "PUT",
        { rules: [RULE], lodgeId: "lodge-2", nonMemberHoldDays: 5 },
      ),
    );

    expect(res.status).toBe(400);
    expect(mocks.cancellationDeleteMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown or inactive lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue(null);

    const res = await CANCELLATION_PUT(
      request(
        "http://localhost/api/admin/booking-policies/cancellation",
        "PUT",
        { rules: [RULE], lodgeId: "lodge-missing" },
      ),
    );

    expect(res.status).toBe(400);
    expect(mocks.cancellationDeleteMany).not.toHaveBeenCalled();
  });
});

describe("minimum-stay policy partitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.minimumStayFindMany.mockResolvedValue([]);
    mocks.minimumStayCreate.mockResolvedValue({ id: "msp-1" });
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });
  });

  it("GET partitions by lodge, exact match", async () => {
    await MIN_STAY_GET(
      request(
        "http://localhost/api/admin/booking-policies/minimum-stay?lodgeId=lodge-2",
      ),
    );
    expect(mocks.minimumStayFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lodgeId: "lodge-2" } }),
    );

    await MIN_STAY_GET(
      request("http://localhost/api/admin/booking-policies/minimum-stay"),
    );
    expect(mocks.minimumStayFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { lodgeId: null } }),
    );
  });

  it("POST stamps the requested lodge partition", async () => {
    const res = await MIN_STAY_POST(
      request(
        "http://localhost/api/admin/booking-policies/minimum-stay",
        "POST",
        {
          name: "Winter weekends",
          startDate: "2026-06-01",
          endDate: "2026-09-30",
          triggerDays: [5, 6],
          minimumNights: 2,
          lodgeId: "lodge-2",
        },
      ),
    );

    expect(res.status).toBe(201);
    expect(mocks.minimumStayCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ lodgeId: "lodge-2" }),
    });
  });

  it("POST without a lodge stays club-wide", async () => {
    await MIN_STAY_POST(
      request(
        "http://localhost/api/admin/booking-policies/minimum-stay",
        "POST",
        {
          name: "Winter weekends",
          startDate: "2026-06-01",
          endDate: "2026-09-30",
          triggerDays: [5, 6],
          minimumNights: 2,
        },
      ),
    );

    expect(mocks.minimumStayCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ lodgeId: null }),
    });
  });
});

describe("booking period partitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.bookingPeriodFindMany.mockResolvedValue([]);
    mocks.bookingPeriodCreate.mockResolvedValue({ id: "bp-1" });
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });
  });

  it("GET partitions by lodge, exact match", async () => {
    await PERIODS_GET(
      request(
        "http://localhost/api/admin/booking-policies/periods?lodgeId=lodge-2",
      ),
    );
    expect(mocks.bookingPeriodFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lodgeId: "lodge-2" } }),
    );
  });

  it("POST stamps the requested lodge partition and validates the lodge", async () => {
    const res = await PERIODS_POST(
      request("http://localhost/api/admin/booking-policies/periods", "POST", {
        name: "School holidays",
        startDate: "2026-07-01",
        endDate: "2026-07-20",
        nonMemberHoldDays: 14,
        cancellationRules: [RULE],
        lodgeId: "lodge-2",
      }),
    );

    expect(res.status).toBe(201);
    expect(mocks.bookingPeriodCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ lodgeId: "lodge-2" }),
    });

    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-x", active: false });
    const rejected = await PERIODS_POST(
      request("http://localhost/api/admin/booking-policies/periods", "POST", {
        name: "School holidays",
        startDate: "2026-07-01",
        endDate: "2026-07-20",
        nonMemberHoldDays: 14,
        cancellationRules: [RULE],
        lodgeId: "lodge-x",
      }),
    );
    expect(rejected.status).toBe(400);
  });

  it("POST rejects duplicate cancellation thresholds without side effects", async () => {
    const res = await PERIODS_POST(
      request("http://localhost/api/admin/booking-policies/periods", "POST", {
        name: "Dirty policy",
        startDate: "2026-07-01",
        endDate: "2026-07-20",
        nonMemberHoldDays: 14,
        cancellationRules: [RULE, { ...RULE, refundPercentage: 10 }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({
      error: "Validation failed",
      details: expect.arrayContaining([expect.objectContaining({
        path: ["cancellationRules"],
        message: "Cancellation rule day thresholds must be unique",
      })]),
    }));
    expect(mocks.bookingPeriodCreate).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });

  it("PUT rejects duplicate cancellation thresholds without side effects", async () => {
    const res = await PERIOD_PUT(
      request("http://localhost/api/admin/booking-policies/periods/bp-1", "PUT", {
        cancellationRules: [RULE, { ...RULE, refundPercentage: 10 }],
      }),
      { params: Promise.resolve({ id: "bp-1" }) },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({
      error: "Validation failed",
      details: expect.arrayContaining([expect.objectContaining({
        path: ["cancellationRules"],
        message: "Cancellation rule day thresholds must be unique",
      })]),
    }));
    expect(mocks.bookingPeriodFindUnique).not.toHaveBeenCalled();
    expect(mocks.bookingPeriodUpdate).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });
});
