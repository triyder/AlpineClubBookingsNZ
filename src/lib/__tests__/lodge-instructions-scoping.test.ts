import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  lodgeInstructionFindMany: vi.fn(),
  lodgeInstructionFindFirst: vi.fn(),
  lodgeInstructionCreate: vi.fn(),
  lodgeInstructionUpdate: vi.fn(),
  lodgeInstructionDeleteMany: vi.fn(),
  lodgeFindUnique: vi.fn(),
  auditLogCreate: vi.fn(),
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditRequestContext: vi.fn(() => ({
    id: "req-1",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  })),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: mocks.buildStructuredAuditLogCreateArgs,
  getAuditRequestContext: mocks.getAuditRequestContext,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodgeInstruction: {
      findMany: mocks.lodgeInstructionFindMany,
      findFirst: mocks.lodgeInstructionFindFirst,
      create: mocks.lodgeInstructionCreate,
      update: mocks.lodgeInstructionUpdate,
      deleteMany: mocks.lodgeInstructionDeleteMany,
    },
    lodge: {
      findUnique: mocks.lodgeFindUnique,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
  },
}));

import {
  GET as adminGET,
  PUT as adminPUT,
} from "@/app/api/admin/lodge-instructions/route";
import { getSanitizedLodgeInstructions } from "@/lib/lodge-instructions";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};

const clubWideRows = [
  {
    key: "OPEN",
    contentHtml: "<p>Club-wide open</p>",
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    lodgeId: null,
  },
  {
    key: "CLOSE",
    contentHtml: "<p>Club-wide close</p>",
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    lodgeId: null,
  },
  {
    key: "DAY_TO_DAY",
    contentHtml: "<p>Club-wide day-to-day</p>",
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    lodgeId: null,
  },
];

const lodgeOpenOverride = {
  key: "OPEN",
  contentHtml: "<p>Lodge open</p>",
  updatedAt: new Date("2026-06-20T00:00:00Z"),
  lodgeId: "lodge-2",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.auth.mockResolvedValue(adminSession);
  mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });
  mocks.auditLogCreate.mockResolvedValue({});
  mocks.lodgeInstructionDeleteMany.mockResolvedValue({ count: 1 });
  mocks.lodgeInstructionCreate.mockImplementation(
    async ({ data }: { data: { key: string; contentHtml: string; lodgeId: string | null } }) => ({
      id: "lodge-instruction-new",
      key: data.key,
      contentHtml: data.contentHtml,
      lodgeId: data.lodgeId,
      updatedAt: new Date("2026-06-21T00:00:00Z"),
    }),
  );
  mocks.lodgeInstructionUpdate.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: { contentHtml: string } }) => ({
      id: where.id,
      key: "OPEN",
      contentHtml: data.contentHtml,
      lodgeId: "lodge-2",
      updatedAt: new Date("2026-06-21T00:00:00Z"),
    }),
  );
});

describe("getSanitizedLodgeInstructions lodge scoping", () => {
  it("prefers a lodge's override row over the club-wide row for that key", async () => {
    mocks.lodgeInstructionFindMany.mockResolvedValue([
      ...clubWideRows,
      lodgeOpenOverride,
    ]);

    const documents = await getSanitizedLodgeInstructions("lodge-2");

    expect(mocks.lodgeInstructionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ lodgeId: null }, { lodgeId: "lodge-2" }] },
      }),
    );
    expect(documents.map((doc) => doc.key)).toEqual([
      "OPEN",
      "CLOSE",
      "DAY_TO_DAY",
    ]);
    // The override replaces the club-wide OPEN document entirely.
    expect(documents[0].contentHtml).toBe("<p>Lodge open</p>");
    expect(documents[0].updatedAt).toBe("2026-06-20T00:00:00.000Z");
    // Keys without an override fall back to the club-wide documents.
    expect(documents[1].contentHtml).toBe("<p>Club-wide close</p>");
    expect(documents[2].contentHtml).toBe("<p>Club-wide day-to-day</p>");
  });

  it("prefers the override regardless of row order", async () => {
    mocks.lodgeInstructionFindMany.mockResolvedValue([
      lodgeOpenOverride,
      ...clubWideRows,
    ]);

    const documents = await getSanitizedLodgeInstructions("lodge-2");
    expect(documents[0].contentHtml).toBe("<p>Lodge open</p>");
    expect(documents[1].contentHtml).toBe("<p>Club-wide close</p>");
  });

  it("reads only the club-wide partition when no lodge is given", async () => {
    mocks.lodgeInstructionFindMany.mockResolvedValue(clubWideRows);

    const documents = await getSanitizedLodgeInstructions();

    expect(mocks.lodgeInstructionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lodgeId: null } }),
    );
    expect(documents[0].contentHtml).toBe("<p>Club-wide open</p>");
  });
});

describe("admin GET partition listing", () => {
  it("returns the exact lodge partition with hasOverride flags", async () => {
    mocks.lodgeInstructionFindMany.mockResolvedValue([lodgeOpenOverride]);

    const response = await adminGET(
      new NextRequest(
        "http://localhost/api/admin/lodge-instructions?lodgeId=lodge-2",
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(mocks.lodgeInstructionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lodgeId: "lodge-2" } }),
    );
    expect(body.lodgeId).toBe("lodge-2");
    expect(body.documents).toHaveLength(3);
    const open = body.documents.find((doc: { key: string }) => doc.key === "OPEN");
    const close = body.documents.find((doc: { key: string }) => doc.key === "CLOSE");
    expect(open.hasOverride).toBe(true);
    expect(open.contentHtml).toBe("<p>Lodge open</p>");
    // No fallback merge on the admin surface: a key without an override
    // comes back empty so the editor can offer "create override".
    expect(close.hasOverride).toBe(false);
    expect(close.contentHtml).toBe("");
  });

  it("flags nothing as an override on the club-wide partition", async () => {
    mocks.lodgeInstructionFindMany.mockResolvedValue(clubWideRows);

    const response = await adminGET(
      new NextRequest("http://localhost/api/admin/lodge-instructions"),
    );
    const body = await response.json();
    expect(body.lodgeId).toBeNull();
    expect(
      body.documents.every((doc: { hasOverride: boolean }) => !doc.hasOverride),
    ).toBe(true);
  });
});

describe("admin PUT partition writes", () => {
  function putRequest(body: unknown) {
    return new NextRequest("http://localhost/api/admin/lodge-instructions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("creates a lodge override in the lodge's partition", async () => {
    mocks.lodgeInstructionFindFirst.mockResolvedValue(null);

    const response = await adminPUT(
      putRequest({
        key: "OPEN",
        contentHtml: "<p>Lodge open</p>",
        lodgeId: "lodge-2",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.lodgeFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "lodge-2" } }),
    );
    expect(mocks.lodgeInstructionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "OPEN", lodgeId: "lodge-2" } }),
    );
    expect(mocks.lodgeInstructionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          key: "OPEN",
          lodgeId: "lodge-2",
          contentHtml: "<p>Lodge open</p>",
        }),
      }),
    );
    const body = await response.json();
    expect(body.document.lodgeId).toBe("lodge-2");
    expect(body.document.hasOverride).toBe(true);
  });

  it("updates an existing lodge override in place", async () => {
    mocks.lodgeInstructionFindFirst.mockResolvedValue({
      id: "lodge-instruction-override",
      contentHtml: "<p>Old override</p>",
    });

    const response = await adminPUT(
      putRequest({
        key: "OPEN",
        contentHtml: "<p>New override</p>",
        lodgeId: "lodge-2",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.lodgeInstructionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "lodge-instruction-override" },
        data: expect.objectContaining({ contentHtml: "<p>New override</p>" }),
      }),
    );
    expect(mocks.lodgeInstructionCreate).not.toHaveBeenCalled();
  });

  it("writes to the club-wide partition when lodgeId is omitted", async () => {
    mocks.lodgeInstructionFindFirst.mockResolvedValue(null);

    const response = await adminPUT(
      putRequest({ key: "CLOSE", contentHtml: "<p>Club-wide close</p>" }),
    );

    expect(response.status).toBe(200);
    // Omitted lodgeId means the club-wide null partition, never the
    // default lodge, so no lodge validation runs.
    expect(mocks.lodgeFindUnique).not.toHaveBeenCalled();
    expect(mocks.lodgeInstructionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "CLOSE", lodgeId: null } }),
    );
    expect(mocks.lodgeInstructionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ key: "CLOSE", lodgeId: null }),
      }),
    );
  });

  it("rejects an inactive or unknown lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: false });

    const response = await adminPUT(
      putRequest({
        key: "OPEN",
        contentHtml: "<p>Lodge open</p>",
        lodgeId: "lodge-2",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.lodgeInstructionCreate).not.toHaveBeenCalled();
    expect(mocks.lodgeInstructionUpdate).not.toHaveBeenCalled();
  });

  it("removes a lodge override with remove: true", async () => {
    const response = await adminPUT(
      putRequest({ key: "OPEN", lodgeId: "lodge-2", remove: true }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.removed).toBe(true);
    expect(mocks.lodgeInstructionDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "OPEN", lodgeId: "lodge-2" } }),
    );
    expect(mocks.lodgeInstructionCreate).not.toHaveBeenCalled();
    expect(mocks.lodgeInstructionUpdate).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "LODGE_INSTRUCTION_UPDATED" }),
      }),
    );
  });

  it("refuses to remove the club-wide documents", async () => {
    const response = await adminPUT(
      putRequest({ key: "OPEN", remove: true }),
    );

    expect(response.status).toBe(400);
    expect(mocks.lodgeInstructionDeleteMany).not.toHaveBeenCalled();
  });
});
