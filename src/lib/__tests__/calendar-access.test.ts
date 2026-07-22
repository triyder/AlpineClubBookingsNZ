import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  committeeFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    committeeAssignment: { findFirst: mocks.committeeFindFirst },
  },
}));

import { canManageCalendarEvents } from "@/lib/calendar-access";

const lodgeEditMatrix = {
  overview: "none",
  bookings: "none",
  membership: "none",
  finance: "none",
  lodge: "edit",
  content: "none",
  support: "none",
} as const;

const noAccessMatrix = { ...lodgeEditMatrix, lodge: "none" } as const;

describe("canManageCalendarEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("grants a lodge-edit admin without touching the committee table", async () => {
    const result = await canManageCalendarEvents({
      id: "member-1",
      adminPermissionMatrix: lodgeEditMatrix,
    });
    expect(result).toBe(true);
    expect(mocks.committeeFindFirst).not.toHaveBeenCalled();
  });

  it("grants a non-admin who holds an active committee assignment", async () => {
    mocks.committeeFindFirst.mockResolvedValue({ id: "assign-1" });
    const result = await canManageCalendarEvents({
      id: "member-2",
      adminPermissionMatrix: noAccessMatrix,
    });
    expect(result).toBe(true);
    expect(mocks.committeeFindFirst).toHaveBeenCalledOnce();
  });

  it("denies a plain member with no committee assignment", async () => {
    mocks.committeeFindFirst.mockResolvedValue(null);
    const result = await canManageCalendarEvents({
      id: "member-3",
      adminPermissionMatrix: noAccessMatrix,
    });
    expect(result).toBe(false);
  });
});
