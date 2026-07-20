import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// -----------------------------------------------------------------------------
// #2089: the 422 create-gate mapping must fire only for the shrunk required set
// (name + email). A sparse member (name + email only) pushes through; a member
// missing email/name returns 422 listing only those fields. The duplicate
// pre-check (409 + suggestedContacts) is unchanged.
// -----------------------------------------------------------------------------

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

const mockMemberFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findUnique: (...a: unknown[]) => mockMemberFindUnique(...a) } },
}));

const mockCreate = vi.fn();
const mockFindPotential = vi.fn();
const mockFlush = vi.fn();
const mockSyncHistory = vi.fn();
// Fully stub the Xero barrel. XeroContactValidationError is defined HERE so the
// route's `instanceof` check (which imports the same mocked class) matches when
// the test rejects createXeroContactForMember with it.
vi.mock("@/lib/xero", () => {
  class XeroContactValidationError extends Error {
    missingFields: string[];
    constructor(missingFields: string[]) {
      super(
        `Member is missing required fields for Xero contact creation: ${missingFields.join(", ")}`
      );
      this.name = "XeroContactValidationError";
      this.missingFields = missingFields;
    }
  }
  return {
    XeroContactValidationError,
    createXeroContactForMember: (...a: unknown[]) => mockCreate(...a),
    findPotentialXeroContactsForMember: (...a: unknown[]) => mockFindPotential(...a),
    flushMemberSubscriptionHistory: (...a: unknown[]) => mockFlush(...a),
    syncMemberSubscriptionHistoryForLinkedContact: (...a: unknown[]) =>
      mockSyncHistory(...a),
  };
});

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/xero-links", () => ({
  buildXeroContactUrl: (id: string) => `https://go.xero.com/app/contacts/contact/${id}`,
}));
vi.mock("@/lib/xero-api-errors", () => ({
  getXeroApiErrorInfo: () => ({
    handled: true,
    diagnosticMessage: "diag",
    clientMessage: "Failed to create Xero contact",
    status: 502,
  }),
}));
vi.mock("@/lib/utils", () => ({ getSeasonYear: () => 2026 }));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroEntranceFeeInvoiceOperation: vi.fn(),
  processQueuedXeroOutboxOperations: vi.fn(),
}));

import { POST } from "@/app/api/admin/members/[id]/xero-push/route";
import { XeroContactValidationError } from "@/lib/xero";

function okGuard(userId = "admin-1") {
  return { ok: true as const, session: { user: { id: userId } } };
}
function forbiddenGuard() {
  return {
    ok: false as const,
    response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  };
}

function postReq(body: unknown = {}) {
  return new NextRequest("http://localhost/api/admin/members/mem_1/xero-push", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const params = Promise.resolve({ id: "mem_1" });

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(okGuard());
  mockMemberFindUnique.mockResolvedValue({
    id: "mem_1",
    firstName: "Alice",
    lastName: "Example",
    email: "alice@example.org",
    xeroContactId: null,
  });
  mockFindPotential.mockResolvedValue([]);
  mockFlush.mockResolvedValue({ seasonYears: [], deletedCount: 0 });
  mockSyncHistory.mockResolvedValue({ errors: [], seasonYears: [] });
});

describe("POST /api/admin/members/[id]/xero-push (#2089)", () => {
  it("gates on finance:edit", async () => {
    mockCreate.mockResolvedValue("contact-1");
    await POST(postReq(), { params });
    expect(mockRequireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "edit" },
    });
  });

  it("403s a caller without finance:edit", async () => {
    mockRequireAdmin.mockResolvedValue(forbiddenGuard());
    const res = await POST(postReq(), { params });
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates a sparse member (name + email only)", async () => {
    mockCreate.mockResolvedValue("contact-1");
    const res = await POST(postReq(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.xeroContactId).toBe("contact-1");
    expect(mockCreate).toHaveBeenCalledWith("mem_1", {
      createdByMemberId: "admin-1",
    });
  });

  it("maps the create-gate validation error to 422 listing only email", async () => {
    mockCreate.mockRejectedValue(new XeroContactValidationError(["Email"]));
    const res = await POST(postReq(), { params });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.missingFields).toEqual(["Email"]);
    expect(body.error).toBe("Complete these fields before creating in Xero: Email");
  });

  it("maps a missing-name validation error to 422 listing only name fields", async () => {
    mockCreate.mockRejectedValue(
      new XeroContactValidationError(["First Name", "Last Name"])
    );
    const res = await POST(postReq(), { params });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.missingFields).toEqual(["First Name", "Last Name"]);
  });

  it("returns 409 with suggestedContacts when duplicates are found (unchanged)", async () => {
    mockFindPotential.mockResolvedValue([
      { contactId: "c9", name: "Alice Example", email: "alice@example.org" },
    ]);
    const res = await POST(postReq(), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.suggestedContacts).toHaveLength(1);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("skips the duplicate pre-check when forceCreate is set", async () => {
    mockCreate.mockResolvedValue("contact-1");
    const res = await POST(postReq({ forceCreate: true }), { params });
    expect(res.status).toBe(200);
    expect(mockFindPotential).not.toHaveBeenCalled();
  });

  it("returns 409 when the member is already linked", async () => {
    mockMemberFindUnique.mockResolvedValue({
      id: "mem_1",
      firstName: "Alice",
      lastName: "Example",
      email: "alice@example.org",
      xeroContactId: "already-linked",
    });
    const res = await POST(postReq(), { params });
    expect(res.status).toBe(409);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
