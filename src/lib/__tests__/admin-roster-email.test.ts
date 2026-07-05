import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockAuth = vi.fn();
const mockChoreAssignmentFindMany = vi.fn();
const mockGuestTokenDeleteMany = vi.fn();
const mockSendChoreRosterEmail = vi.fn();
const mockShouldSendChoreRoster = vi.fn();
const mockCreateGuestChoreToken = vi.fn();
const mockMemberCount = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
  requireAdmin: async (options?: { forbiddenResponse?: () => Response }) => {
    const session = await mockAuth();
    if (!session?.user?.id) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      };
    }
    if (session.user.role !== "ADMIN") {
      return {
        ok: false,
        response:
          options?.forbiddenResponse?.() ??
          new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
      };
    }
    const inactiveResponse = await mockRequireActiveSessionUser(session.user.id);
    if (inactiveResponse) return { ok: false, response: inactiveResponse };
    return { ok: true, session };
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    choreAssignment: {
      findMany: mockChoreAssignmentFindMany,
    },
    member: {
      count: mockMemberCount,
    },
    guestChoreToken: {
      deleteMany: mockGuestTokenDeleteMany,
    },
  },
}));

vi.mock("@/lib/email", () => ({
  sendChoreRosterEmail: mockSendChoreRosterEmail,
  shouldSendChoreRoster: mockShouldSendChoreRoster,
}));

vi.mock("@/lib/guest-chore-token", () => ({
  createGuestChoreToken: mockCreateGuestChoreToken,
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("PUT /api/admin/roster/[date] email action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockCreateGuestChoreToken.mockResolvedValue("token-1");
    mockMemberCount.mockResolvedValue(1);
    // Default: recipient wants the roster. The hybrid resolution itself is unit
    // tested in notification-preference-gating.test.ts; here we assert the
    // service wires its inputs and honors its verdict.
    mockShouldSendChoreRoster.mockResolvedValue(true);
  });

  it("returns partial-failure details instead of failing the whole request", async () => {
    mockChoreAssignmentFindMany.mockResolvedValue([
      {
        choreTemplate: { name: "Kitchen", description: null },
        bookingGuest: {
          id: "guest-1",
          firstName: "Alice",
          lastName: "Smith",
          member: {
            email: "alice@test.com",
            inheritEmailFromId: null,
            inheritEmailFrom: null,
          },
        },
      },
      {
        choreTemplate: { name: "Bathrooms", description: null },
        bookingGuest: {
          id: "guest-2",
          firstName: "Bob",
          lastName: "Jones",
          member: {
            email: "bob@test.com",
            inheritEmailFromId: null,
            inheritEmailFrom: null,
          },
        },
      },
    ]);

    mockSendChoreRosterEmail
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("SMTP down"));

    const { PUT } = await import("@/app/api/admin/roster/[date]/route");
    const req = new NextRequest("http://localhost/api/admin/roster/2026-04-10", {
      method: "PUT",
      body: JSON.stringify({ action: "email" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await PUT(req, { params: Promise.resolve({ date: "2026-04-10" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.partialFailure).toBe(true);
    expect(body.sent).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.failures).toHaveLength(1);
    expect(mockGuestTokenDeleteMany).toHaveBeenCalledTimes(2);
  });

  // #1285 Option C: the service must thread BOTH hybrid inputs — the guest's own
  // member id AND the member they inherit their email from — into
  // `shouldSendChoreRoster`. For a dependent whose email is inherited, delivery
  // goes to the primary's inbox, and gating must follow the same member chain.
  it("threads the dependent's memberId + inheritEmailFromId into the resolver and sends when allowed (#1285)", async () => {
    mockChoreAssignmentFindMany.mockResolvedValue([
      {
        choreTemplate: { name: "Kitchen", description: null },
        bookingGuest: {
          id: "guest-1",
          firstName: "Dana",
          lastName: "Young",
          member: {
            id: "dependent-1",
            email: "dependent@test.com",
            inheritEmailFromId: "primary-1",
            inheritEmailFrom: { email: "primary@test.com" },
          },
        },
      },
    ]);
    mockSendChoreRosterEmail.mockResolvedValue(undefined);

    const { PUT } = await import("@/app/api/admin/roster/[date]/route");
    const req = new NextRequest("http://localhost/api/admin/roster/2026-04-10", {
      method: "PUT",
      body: JSON.stringify({ action: "email" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await PUT(req, { params: Promise.resolve({ date: "2026-04-10" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sent).toBe(1);
    expect(body.skipped).toBe(0);
    // Both hybrid inputs are threaded through.
    expect(mockShouldSendChoreRoster).toHaveBeenCalledWith("dependent-1", "primary-1");
    // Delivery follows the inherited email (the primary's inbox), and the sender
    // is a pure transport — no preference arg is passed to it anymore.
    expect(mockSendChoreRosterEmail).toHaveBeenCalledWith(
      "primary@test.com",
      "Dana Young",
      "2026-04-10",
      [{ name: "Kitchen", description: null }],
      expect.stringContaining("/chores/"),
    );
  });

  // #1285 Option C: an opted-out verdict must be honored BEFORE any token work,
  // so no orphaned GuestChoreToken is created for a suppressed recipient.
  it("suppresses an opted-out recipient before creating a token — no orphaned token, counted as skipped (#1285)", async () => {
    mockChoreAssignmentFindMany.mockResolvedValue([
      {
        choreTemplate: { name: "Kitchen", description: null },
        bookingGuest: {
          id: "guest-1",
          firstName: "Dana",
          lastName: "Young",
          member: {
            id: "dependent-1",
            email: "dependent@test.com",
            inheritEmailFromId: "primary-1",
            inheritEmailFrom: { email: "primary@test.com" },
          },
        },
      },
    ]);
    mockShouldSendChoreRoster.mockResolvedValue(false);

    const { PUT } = await import("@/app/api/admin/roster/[date]/route");
    const req = new NextRequest("http://localhost/api/admin/roster/2026-04-10", {
      method: "PUT",
      body: JSON.stringify({ action: "email" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await PUT(req, { params: Promise.resolve({ date: "2026-04-10" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sent).toBe(0);
    expect(body.skipped).toBe(1);
    expect(mockShouldSendChoreRoster).toHaveBeenCalledWith("dependent-1", "primary-1");
    // No token churn and no send for a suppressed recipient.
    expect(mockGuestTokenDeleteMany).not.toHaveBeenCalled();
    expect(mockCreateGuestChoreToken).not.toHaveBeenCalled();
    expect(mockSendChoreRosterEmail).not.toHaveBeenCalled();
  });
});
