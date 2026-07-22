import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  checkXeroWebhookFreshVerify: vi.fn(),
  getXeroWebhooksVerifiable: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/xero-webhook-validation", () => ({
  checkXeroWebhookFreshVerify: mocks.checkXeroWebhookFreshVerify,
}));
vi.mock("@/lib/xero-config", () => ({
  getXeroWebhooksVerifiable: mocks.getXeroWebhooksVerifiable,
}));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.loggerError } }));

import { GET } from "../route";

const BASE = "https://club.example.com/api/admin/xero/webhook/verify-status";

const RESULT = {
  webhookKeyConfigured: true,
  verified: false,
  freshVerified: false,
  keyMatches: false,
  lastValidatedAt: null,
  serverNow: 1_700_000_000_000,
};

function makeRequest(query = "") {
  return new Request(`${BASE}${query}`, { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1", accessRoles: ["ADMIN"] } },
  });
  mocks.checkXeroWebhookFreshVerify.mockResolvedValue(RESULT);
  mocks.getXeroWebhooksVerifiable.mockReturnValue(true);
});

describe("GET /api/admin/xero/webhook/verify-status — `since` parsing", () => {
  it("rejects `?since=0` as null (0 is not a real verify-start; every marker would look fresh)", async () => {
    await GET(makeRequest("?since=0"));
    expect(mocks.checkXeroWebhookFreshVerify).toHaveBeenCalledWith(null);
  });

  it("rejects a negative `since` as null", async () => {
    await GET(makeRequest("?since=-5"));
    expect(mocks.checkXeroWebhookFreshVerify).toHaveBeenCalledWith(null);
  });

  it("rejects a non-numeric `since` as null", async () => {
    await GET(makeRequest("?since=not-a-number"));
    expect(mocks.checkXeroWebhookFreshVerify).toHaveBeenCalledWith(null);
  });

  it("passes a strictly-positive `since` through unchanged", async () => {
    await GET(makeRequest("?since=1700000000000"));
    expect(mocks.checkXeroWebhookFreshVerify).toHaveBeenCalledWith(
      1_700_000_000_000,
    );
  });

  it("treats an absent `since` as null", async () => {
    await GET(makeRequest());
    expect(mocks.checkXeroWebhookFreshVerify).toHaveBeenCalledWith(null);
  });
});

describe("GET /api/admin/xero/webhook/verify-status — response shape", () => {
  it("includes webhooksVerifiable alongside the freshness result", async () => {
    mocks.getXeroWebhooksVerifiable.mockReturnValue(false);
    const res = await GET(makeRequest("?since=1700000000000"));
    const body = await res.json();
    expect(body).toMatchObject({ ...RESULT, webhooksVerifiable: false });
  });

  it("returns the guard response when the caller is not an admin", async () => {
    const denied = new Response("no", { status: 401 });
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: denied });

    const res = await GET(makeRequest());

    expect(res).toBe(denied);
    expect(mocks.checkXeroWebhookFreshVerify).not.toHaveBeenCalled();
  });
});
