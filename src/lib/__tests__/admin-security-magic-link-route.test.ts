import { beforeEach, describe, expect, it, vi } from "vitest";

// Admin magic-link TTL config API (#2103): support-area gating, audited writes,
// bounds enforcement (min 5–60), and the singleton upsert. The password-policy
// route owns the character rules; this one owns magicLinkTtlMinutes ONLY.

const mocks = vi.hoisted(() => {
  const values = {
    requireAdmin: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    auditCreate: vi.fn(),
  };
  const prisma = {
    loginSecuritySetting: { findUnique: values.findUnique, upsert: values.upsert },
    auditLog: { create: values.auditCreate },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (callback: (tx: typeof prisma) => unknown) => callback(prisma),
  );
  return { ...values, prisma };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: (value: unknown) => ({ data: value }),
  getAuditRequestContext: () => ({}),
}));

import { PUT } from "@/app/api/admin/security/magic-link/route";

function put(body: unknown) {
  return PUT(
    new Request("http://localhost/api/admin/security/magic-link", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  );
}

function grantEditAdmin() {
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mocks.findUnique.mockResolvedValue({ magicLinkTtlMinutes: 15 });
  mocks.upsert.mockResolvedValue({});
}

describe("admin security magic-link route (#2103)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantEditAdmin();
  });

  it("PUT is gated on support:edit, upserts the singleton, and audits under security", async () => {
    const res = await put({ magicLinkTtlMinutes: 30 });
    expect(res.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "support", level: "edit" },
    });
    const upsertArgs = mocks.upsert.mock.calls[0][0];
    expect(upsertArgs.where).toEqual({ id: "default" });
    expect(upsertArgs.update).toMatchObject({
      magicLinkTtlMinutes: 30,
      updatedByMemberId: "admin-1",
    });
    // Only the TTL column is written — never the password-policy fields.
    expect(upsertArgs.update).not.toHaveProperty("minPasswordLength");

    expect(mocks.auditCreate).toHaveBeenCalledOnce();
    const audit = mocks.auditCreate.mock.calls[0][0].data;
    expect(audit.category).toBe("security");
    expect(audit.severity).toBe("important");
    expect(audit.action).toBe("LOGIN_SECURITY_MAGIC_LINK_TTL_UPDATED");
    expect(audit.metadata).toEqual({
      before: { magicLinkTtlMinutes: 15 },
      after: { magicLinkTtlMinutes: 30 },
    });
  });

  it("returns 403 when the guard denies access (no write)", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const res = await put({ magicLinkTtlMinutes: 30 });
    expect(res.status).toBe(403);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects a TTL below the 5 floor (no write)", async () => {
    const res = await put({ magicLinkTtlMinutes: 4 });
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a TTL above the 60 ceiling (no write)", async () => {
    const res = await put({ magicLinkTtlMinutes: 61 });
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a non-integer TTL (no write)", async () => {
    const res = await put({ magicLinkTtlMinutes: 15.5 });
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("pins the TTL accept/reject boundary edges (4 rejected, 5 accepted, 60 accepted, 61 rejected)", async () => {
    // 4 rejected — below the floor.
    expect((await put({ magicLinkTtlMinutes: 4 })).status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();

    // 5 accepted — the floor is inclusive.
    vi.clearAllMocks();
    grantEditAdmin();
    expect((await put({ magicLinkTtlMinutes: 5 })).status).toBe(200);
    expect(mocks.upsert.mock.calls[0][0].update.magicLinkTtlMinutes).toBe(5);

    // 60 accepted — the ceiling is inclusive.
    vi.clearAllMocks();
    grantEditAdmin();
    expect((await put({ magicLinkTtlMinutes: 60 })).status).toBe(200);
    expect(mocks.upsert.mock.calls[0][0].update.magicLinkTtlMinutes).toBe(60);

    // 61 rejected — above the ceiling.
    vi.clearAllMocks();
    grantEditAdmin();
    expect((await put({ magicLinkTtlMinutes: 61 })).status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects an unknown field via the strict schema (no write)", async () => {
    const res = await put({ magicLinkTtlMinutes: 30, minPasswordLength: 16 });
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("creates the singleton with the code default before-metadata when no row exists", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const res = await put({ magicLinkTtlMinutes: 45 });
    expect(res.status).toBe(200);
    const createArgs = mocks.upsert.mock.calls[0][0];
    expect(createArgs.create).toMatchObject({
      id: "default",
      magicLinkTtlMinutes: 45,
      updatedByMemberId: "admin-1",
    });
    const audit = mocks.auditCreate.mock.calls[0][0].data;
    expect(audit.metadata.before).toEqual({ magicLinkTtlMinutes: null });
  });
});
