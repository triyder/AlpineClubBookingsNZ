import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockAuth, mockFindUnique, mockValidateMinimumStay } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindUnique: vi.fn(),
  mockValidateMinimumStay: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mockFindUnique,
    },
  },
}));

vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: mockValidateMinimumStay,
  formatViolationsDetail: () => "minimum stay violation",
}));

import { GET } from "@/app/api/booking-policies/check/route";

function request(url = "https://example.test/api/booking-policies/check?checkIn=2026-07-01&checkOut=2026-07-03") {
  return new NextRequest(url);
}

describe("booking policy check route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
    mockFindUnique.mockResolvedValue({ active: true, forcePasswordChange: false });
    mockValidateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
  });

  it("rejects unauthenticated callers", async () => {
    mockAuth.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorised" });
    expect(mockValidateMinimumStay).not.toHaveBeenCalled();
  });

  it("rejects inactive members", async () => {
    mockFindUnique.mockResolvedValue({ active: false, forcePasswordChange: false });

    const response = await GET(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Account is deactivated",
    });
    expect(mockValidateMinimumStay).not.toHaveBeenCalled();
  });

  it("rejects members who must change their password", async () => {
    mockFindUnique.mockResolvedValue({ active: true, forcePasswordChange: true });

    const response = await GET(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Password change required",
    });
    expect(mockValidateMinimumStay).not.toHaveBeenCalled();
  });

  it("returns policy check results for active members", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      valid: true,
      violations: [],
      message: null,
    });
    // No lodgeId in the query resolves the club-wide/default lodge rules
    // (multi-lodge phase 8 threads an explicit lodge through as a third
    // argument when the booking flow supplies one).
    expect(mockValidateMinimumStay).toHaveBeenCalledWith(
      new Date("2026-07-01"),
      new Date("2026-07-03"),
      null
    );
  });
});
