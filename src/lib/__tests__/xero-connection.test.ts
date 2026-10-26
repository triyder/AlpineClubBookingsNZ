// #3806 R2: ONE function answers "is Xero connected, to which tenant, until
// when" — `readXeroConnection` — and the seven readers that used to pick a
// `XeroToken` row for its non-secret columns all go through it.
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    xeroConnection: { findUnique: vi.fn() },
    membershipLockoutSettings: { findUnique: vi.fn(async () => null) },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));

import {
  isConnectedTenant,
  readXeroConnection,
  XERO_CONNECTION_ID,
} from "@/lib/xero-connection";
import { getStoredFinancialYearResolution } from "@/lib/financial-year-server";
import { connectedXeroTenantId } from "@/lib/config-transfer/categories/xero-config";

const EXPIRES_AT = new Date("2026-07-01T00:30:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.xeroConnection.findUnique.mockResolvedValue(null);
});

describe("readXeroConnection (#3806)", () => {
  it("reads the one row by its fixed id and selects only the two non-secret facts", async () => {
    h.prisma.xeroConnection.findUnique.mockResolvedValue({
      tenantId: "tenant-1",
      expiresAt: EXPIRES_AT,
    });

    await expect(readXeroConnection()).resolves.toEqual({
      tenantId: "tenant-1",
      expiresAt: EXPIRES_AT,
    });
    expect(h.prisma.xeroConnection.findUnique).toHaveBeenCalledWith({
      where: { id: XERO_CONNECTION_ID },
      select: { tenantId: true, expiresAt: true },
    });
    expect(XERO_CONNECTION_ID).toBe("default");
  });

  it("reads on the client it is handed, so a caller's transaction keeps its snapshot", async () => {
    const tx = { xeroConnection: { findUnique: vi.fn(async () => null) } };
    await readXeroConnection(tx as never);
    expect(tx.xeroConnection.findUnique).toHaveBeenCalledTimes(1);
    expect(h.prisma.xeroConnection.findUnique).not.toHaveBeenCalled();
  });

  it("calls a connection connected only when it names a tenant", () => {
    expect(isConnectedTenant(null)).toBe(false);
    expect(isConnectedTenant({ tenantId: null, expiresAt: EXPIRES_AT })).toBe(false);
    expect(isConnectedTenant({ tenantId: "t", expiresAt: EXPIRES_AT })).toBe(true);
  });
});

describe("the moved readers answer from the connection row (#3806)", () => {
  it("the stored financial-year resolution refuses only for a connected tenant", async () => {
    await expect(getStoredFinancialYearResolution()).resolves.toMatchObject({
      ok: true,
      source: "default_without_xero",
    });

    h.prisma.xeroConnection.findUnique.mockResolvedValue({ tenantId: null, expiresAt: EXPIRES_AT });
    await expect(getStoredFinancialYearResolution()).resolves.toMatchObject({ ok: true });

    h.prisma.xeroConnection.findUnique.mockResolvedValue({
      tenantId: "tenant-1",
      expiresAt: EXPIRES_AT,
    });
    await expect(getStoredFinancialYearResolution()).resolves.toEqual({
      ok: false,
      reason: "connected_xero_month_not_stored",
    });
  });

  it("config transfer's tenant stamp is the connection's tenant, on the client it is given", async () => {
    const db = {
      xeroConnection: {
        findUnique: vi.fn(async () => ({ tenantId: "tenant-9", expiresAt: EXPIRES_AT })),
      },
    };
    await expect(connectedXeroTenantId(db as never)).resolves.toBe("tenant-9");
    db.xeroConnection.findUnique.mockResolvedValue(null as never);
    await expect(connectedXeroTenantId(db as never)).resolves.toBeNull();
  });

  // The seven readers #3806 names, plus the token store's own status reads. A
  // structural pin, because several of them are reached only through routes or
  // snapshot builders whose own suites mock the reader away.
  const READERS = [
    "src/lib/xero-token-store.ts",
    "src/lib/health-check.ts",
    "src/app/api/admin/setup/provider-test/route.ts",
    "src/lib/financial-year-server.ts",
    "src/lib/config-transfer/categories/xero-config.ts",
    "src/lib/xero-admin-cache.ts",
    "src/lib/setup-readiness-db.ts",
  ];

  it.each(READERS)("%s asks readXeroConnection", (file) => {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    expect(source).toMatch(/\breadXeroConnection\(/);
  });

  it.each(READERS.filter((file) => file !== "src/lib/xero-token-store.ts"))(
    "%s no longer reads XeroToken at all",
    (file) => {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/\bxeroToken\b/);
      expect(source).not.toContain("XERO_TOKEN_ROW_ORDER");
    },
  );
});
