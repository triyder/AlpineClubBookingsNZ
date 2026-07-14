import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  seasonFindMany: vi.fn(),
  seasonFindFirst: vi.fn(),
  seasonFindUnique: vi.fn(),
  seasonCreate: vi.fn(),
  seasonUpdate: vi.fn(),
  lodgeFindFirst: vi.fn(),
  lodgeFindUnique: vi.fn(),
  seasonRateDeleteMany: vi.fn(),
  seasonRateCreateMany: vi.fn(),
  transaction: vi.fn(),
  logAudit: vi.fn(),
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
    season: {
      findMany: mocks.seasonFindMany,
      findFirst: mocks.seasonFindFirst,
      findUnique: mocks.seasonFindUnique,
      create: mocks.seasonCreate,
      update: mocks.seasonUpdate,
    },
    lodge: {
      findFirst: mocks.lodgeFindFirst,
      findUnique: mocks.lodgeFindUnique,
    },
    $transaction: mocks.transaction,
  },
}));

import { GET, POST } from "@/app/api/admin/seasons/route";
import { PUT } from "@/app/api/admin/seasons/[id]/route";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};

const validRates = [
  { ageTier: "ADULT", isMember: true, pricePerNightCents: 4500 },
];

function jsonRequest(url: string, method: "POST" | "PUT", body: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("admin season routes (multi-lodge phase 7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
    mocks.seasonFindFirst.mockResolvedValue(null);
    mocks.seasonCreate.mockResolvedValue({ id: "season-1", rates: [] });
  });

  it("lists every season when no lodge filter is given", async () => {
    mocks.seasonFindMany.mockResolvedValue([]);

    const res = await GET(new NextRequest("http://localhost/api/admin/seasons"));

    expect(res.status).toBe(200);
    expect(mocks.seasonFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined }),
    );
  });

  it("filters seasons strictly to a lodge", async () => {
    mocks.seasonFindMany.mockResolvedValue([]);

    const res = await GET(
      new NextRequest("http://localhost/api/admin/seasons?lodgeId=lodge-2"),
    );

    expect(res.status).toBe(200);
    expect(mocks.seasonFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { lodgeId: "lodge-2" },
      }),
    );
  });

  it("creates a season at the requested lodge and scopes the overlap check to it", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const res = await POST(
      jsonRequest("http://localhost/api/admin/seasons", "POST", {
        name: "Winter 2026",
        type: "WINTER",
        startDate: "2026-06-01",
        endDate: "2026-09-30",
        rates: validRates,
        lodgeId: "lodge-2",
      }),
    );

    expect(res.status).toBe(201);
    expect(mocks.seasonFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { lodgeId: "lodge-2" },
          ]),
        }),
      }),
    );
    expect(mocks.seasonCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lodgeId: "lodge-2" }),
      }),
    );
    expect(mocks.revalidatePublicPageContent).toHaveBeenCalledOnce();
  });

  it("rejects a season at an unknown or inactive lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: false });

    const res = await POST(
      jsonRequest("http://localhost/api/admin/seasons", "POST", {
        name: "Winter 2026",
        type: "WINTER",
        startDate: "2026-06-01",
        endDate: "2026-09-30",
        rates: validRates,
        lodgeId: "lodge-2",
      }),
    );

    expect(res.status).toBe(400);
    expect(mocks.seasonCreate).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });

  it("stamps the default lodge when none is requested", async () => {
    const res = await POST(
      jsonRequest("http://localhost/api/admin/seasons", "POST", {
        name: "Winter 2026",
        type: "WINTER",
        startDate: "2026-06-01",
        endDate: "2026-09-30",
        rates: validRates,
      }),
    );

    expect(res.status).toBe(201);
    expect(mocks.lodgeFindUnique).not.toHaveBeenCalled();
    expect(mocks.seasonCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lodgeId: "lodge-1" }),
      }),
    );
  });

  it("still rejects overlapping seasons at the same lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });
    mocks.seasonFindFirst.mockResolvedValue({
      id: "season-existing",
      name: "Existing Winter",
    });

    const res = await POST(
      jsonRequest("http://localhost/api/admin/seasons", "POST", {
        name: "Winter 2026",
        type: "WINTER",
        startDate: "2026-06-01",
        endDate: "2026-09-30",
        rates: validRates,
        lodgeId: "lodge-2",
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("Existing Winter");
    expect(mocks.seasonCreate).not.toHaveBeenCalled();
  });

  it("scopes the update overlap check to the season's own lodge", async () => {
    mocks.seasonFindUnique.mockResolvedValue({
      id: "season-1",
      name: "Winter 2026",
      lodgeId: "lodge-2",
      startDate: new Date("2026-06-01"),
      endDate: new Date("2026-09-30"),
    });
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        season: {
          update: mocks.seasonUpdate,
          findUnique: mocks.seasonFindUnique,
        },
        seasonRate: {
          deleteMany: mocks.seasonRateDeleteMany,
          createMany: mocks.seasonRateCreateMany,
        },
      }),
    );

    const res = await PUT(
      jsonRequest("http://localhost/api/admin/seasons/season-1", "PUT", {
        startDate: "2026-06-15",
        endDate: "2026-10-15",
      }),
      { params: Promise.resolve({ id: "season-1" }) },
    );

    expect(res.status).toBe(200);
    expect(mocks.seasonFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: "season-1" },
          AND: expect.arrayContaining([
            { lodgeId: "lodge-2" },
          ]),
        }),
      }),
    );
    expect(mocks.revalidatePublicPageContent).toHaveBeenCalledOnce();
  });
});
