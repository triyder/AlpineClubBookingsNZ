import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  isFullAdmin: vi.fn(),
  setIntegrationCredential: vi.fn(),
  createAuditLog: vi.fn(),
  deleteXeroTokens: vi.fn(),
  loggerError: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/access-roles", () => ({ isFullAdmin: mocks.isFullAdmin }));
vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findMany: mocks.findMany } },
}));
vi.mock("@/lib/integration-credentials", () => ({
  setIntegrationCredential: mocks.setIntegrationCredential,
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
  getAuditRequestContext: () => ({ id: null, ipAddress: "1.2.3.4", userAgent: "test" }),
}));
vi.mock("@/lib/xero-token-store", () => ({ deleteXeroTokens: mocks.deleteXeroTokens }));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.loggerError } }));

import { WeakAuthSecretError } from "@/lib/integration-crypto";
import { GET, POST } from "../route";

const SECRET_VALUE = "super-secret-xero-client-secret-value";

function makeRequest(body: unknown) {
  return new Request("https://club.example.com/api/admin/integrations/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(provider: string) {
  return new Request(
    `https://club.example.com/api/admin/integrations/credentials?provider=${provider}`,
    { method: "GET" },
  );
}

function asAdmin(accessRoles: string[], fullAdmin: boolean) {
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1", accessRoles } },
  });
  mocks.isFullAdmin.mockReturnValue(fullAdmin);
}

function asFullAdmin() {
  asAdmin(["ADMIN"], true);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setIntegrationCredential.mockResolvedValue({
    provider: "xero",
    key: "client_secret",
    secretSource: "AUTH_SECRET",
    labelVersion: "integration-credential:v1",
    updatedAt: new Date("2026-07-21T10:00:00.000Z"),
  });
});

describe("POST /api/admin/integrations/credentials", () => {
  it("rejects a non-Full-Admin with 403 and writes nothing", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "area-admin", accessRoles: ["FINANCE_ADMIN"] } },
    });
    mocks.isFullAdmin.mockReturnValue(false);

    const res = await POST(
      makeRequest({ provider: "xero", key: "client_secret", value: SECRET_VALUE }),
    );
    expect(res.status).toBe(403);
    expect(mocks.setIntegrationCredential).not.toHaveBeenCalled();
  });

  it("stores a credential, returns metadata only (no value), and audits metadata only", async () => {
    asFullAdmin();
    const res = await POST(
      makeRequest({ provider: "xero", key: "client_secret", value: SECRET_VALUE }),
    );
    expect(res.status).toBe(200);

    const json = await res.json();
    // Exposure: the value never appears in the response.
    expect(JSON.stringify(json)).not.toContain(SECRET_VALUE);
    expect(json).toMatchObject({ ok: true, provider: "xero", key: "client_secret" });
    expect(json.setAt).toBe("2026-07-21T10:00:00.000Z");

    // Audit metadata contains no substring of the submitted secret.
    expect(mocks.createAuditLog).toHaveBeenCalledTimes(1);
    const auditArg = mocks.createAuditLog.mock.calls[0][0];
    expect(JSON.stringify(auditArg)).not.toContain(SECRET_VALUE);
    expect(auditArg.metadata).toMatchObject({ provider: "xero", key: "client_secret" });
    expect(auditArg.category).toBe("security");
  });

  it("applies verify-reset (drops Xero tokens) on a client-credential write", async () => {
    asFullAdmin();
    await POST(makeRequest({ provider: "xero", key: "client_secret", value: SECRET_VALUE }));
    expect(mocks.deleteXeroTokens).toHaveBeenCalledTimes(1);
  });

  it("does NOT drop Xero tokens when only the webhook key changes", async () => {
    asFullAdmin();
    mocks.setIntegrationCredential.mockResolvedValue({
      provider: "xero",
      key: "webhook_key",
      secretSource: "AUTH_SECRET",
      labelVersion: "integration-credential:v1",
      updatedAt: new Date(),
    });
    await POST(makeRequest({ provider: "xero", key: "webhook_key", value: "hook" }));
    expect(mocks.deleteXeroTokens).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider/key with 400", async () => {
    asFullAdmin();
    const res = await POST(
      makeRequest({ provider: "xero", key: "not_a_real_key", value: "x" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.setIntegrationCredential).not.toHaveBeenCalled();
  });

  it("surfaces the weak-auth-secret gate as a plain-English 400", async () => {
    asFullAdmin();
    mocks.setIntegrationCredential.mockRejectedValue(
      new WeakAuthSecretError("The auth secret is still the .env.example placeholder."),
    );
    const res = await POST(
      makeRequest({ provider: "xero", key: "client_secret", value: SECRET_VALUE }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/placeholder/i);
    expect(JSON.stringify(json)).not.toContain(SECRET_VALUE);
  });
});

describe("GET /api/admin/integrations/credentials (metadata-only)", () => {
  it("returns set/not-set + setAt + secretSource, and NEVER a value or ciphertext", async () => {
    // Any admin may read status (area admins keep visibility, epic decision 4).
    asAdmin(["FINANCE_ADMIN"], false);
    mocks.findMany.mockResolvedValue([
      {
        key: "client_id",
        secretSource: "AUTH_SECRET",
        updatedAt: new Date("2026-07-21T10:00:00.000Z"),
      },
    ]);

    const res = await GET(makeGetRequest("xero"));
    expect(res.status).toBe(200);
    const json = await res.json();

    // client_id is set with its metadata; the other keys are simply absent.
    expect(json).toMatchObject({
      provider: "xero",
      credentials: {
        client_id: {
          set: true,
          setAt: "2026-07-21T10:00:00.000Z",
          secretSource: "AUTH_SECRET",
        },
      },
    });
    expect(json.credentials.client_secret).toBeUndefined();

    // Exposure contract: no value/ciphertext/iv/authTag anywhere in the body,
    // and the DB query itself selects only metadata columns.
    const serialized = JSON.stringify(json);
    for (const forbidden of ["ciphertext", "iv", "authTag", "value"]) {
      expect(serialized).not.toContain(forbidden);
    }
    const selectArg = mocks.findMany.mock.calls[0][0].select;
    expect(selectArg).toEqual({ key: true, secretSource: true, updatedAt: true });
  });

  it("rejects an unknown provider with 400", async () => {
    asAdmin(["ADMIN"], true);
    const res = await GET(makeGetRequest("not_a_provider"));
    expect(res.status).toBe(400);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller via the admin guard", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    const res = await GET(makeGetRequest("xero"));
    expect(res.status).toBe(401);
  });
});
