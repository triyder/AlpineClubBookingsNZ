import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { hutLeaderAssignment: { findFirst: mocks.findFirst } },
}));

import { verifyHutLeaderPinForAssignment } from "@/lib/lodge-pin-session";

const PIN = "654321";

async function assignment(overrides: Record<string, unknown> = {}) {
  return {
    id: "assign-1",
    memberId: "mem-1",
    lodgeId: "lodge-b",
    hutLeaderPin: await bcrypt.hash(PIN, 10),
    member: { id: "mem-1", active: true },
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("verifyHutLeaderPinForAssignment (#1642)", () => {
  it("returns the assignment (with lodgeId) for a correct PIN on a current/upcoming, active assignment", async () => {
    mocks.findFirst.mockResolvedValue(await assignment());
    const result = await verifyHutLeaderPinForAssignment("assign-1", PIN);
    expect(result).not.toBeNull();
    expect(result?.lodgeId).toBe("lodge-b");
    // The query is scoped by id and endDate>=today (current or upcoming).
    const where = mocks.findFirst.mock.calls[0][0].where;
    expect(where.id).toBe("assign-1");
    expect(where.endDate.gte).toBeInstanceOf(Date);
  });

  it("returns null for a wrong PIN", async () => {
    mocks.findFirst.mockResolvedValue(await assignment());
    expect(await verifyHutLeaderPinForAssignment("assign-1", "000000")).toBeNull();
  });

  it("returns null when the member is inactive", async () => {
    mocks.findFirst.mockResolvedValue(await assignment({ member: { id: "mem-1", active: false } }));
    expect(await verifyHutLeaderPinForAssignment("assign-1", PIN)).toBeNull();
  });

  it("returns null when no matching active/current-or-upcoming assignment exists", async () => {
    mocks.findFirst.mockResolvedValue(null);
    expect(await verifyHutLeaderPinForAssignment("nope", PIN)).toBeNull();
  });
});
