import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    webhookValidationReceipt: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
  },
  getOperationalXeroWebhookKey: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/xero-config", () => ({
  getOperationalXeroWebhookKey: mocks.getOperationalXeroWebhookKey,
}));

import {
  checkXeroWebhookFreshVerify,
  computeWebhookKeyFingerprint,
  recordXeroWebhookValidation,
  WEBHOOK_VERIFY_WINDOW_MS,
  XERO_WEBHOOK_PROVIDER,
} from "@/lib/xero-webhook-validation";

const KEY = "current-webhook-key";
const OTHER_KEY = "a-previous-webhook-key";

/** A stored marker row for `key`, validated at `validatedAt`. */
function receiptRow(key: string, validatedAt: Date) {
  return {
    id: "rcpt-1",
    provider: XERO_WEBHOOK_PROVIDER,
    validatedAt,
    keyFingerprint: computeWebhookKeyFingerprint(key),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("xero-webhook-validation (ITR receipt sink + freshness)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOperationalXeroWebhookKey.mockResolvedValue(KEY);
  });

  it("fingerprints are stable, key-specific, and never the key itself", () => {
    expect(computeWebhookKeyFingerprint(KEY)).toBe(
      computeWebhookKeyFingerprint(KEY),
    );
    expect(computeWebhookKeyFingerprint(KEY)).not.toBe(
      computeWebhookKeyFingerprint(OTHER_KEY),
    );
    const fp = computeWebhookKeyFingerprint(KEY);
    expect(fp).not.toContain(KEY);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records the ITR marker with the current key's fingerprint", async () => {
    mocks.prisma.webhookValidationReceipt.upsert.mockResolvedValue({});
    const now = new Date("2026-07-22T10:00:00.000Z");

    await recordXeroWebhookValidation(KEY, now);

    expect(mocks.prisma.webhookValidationReceipt.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider: XERO_WEBHOOK_PROVIDER },
        create: expect.objectContaining({
          provider: XERO_WEBHOOK_PROVIDER,
          validatedAt: now,
          keyFingerprint: computeWebhookKeyFingerprint(KEY),
        }),
        update: expect.objectContaining({
          validatedAt: now,
          keyFingerprint: computeWebhookKeyFingerprint(KEY),
        }),
      }),
    );
  });

  // --- Freshness property (binding, #2081) -------------------------------

  it("verifies fresh: a marker under the current key, newer than verify-start", async () => {
    const since = 1_000_000;
    mocks.prisma.webhookValidationReceipt.findUnique.mockResolvedValue(
      receiptRow(KEY, new Date(since + 5_000)),
    );

    const result = await checkXeroWebhookFreshVerify(since);

    expect(result.freshVerified).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.keyMatches).toBe(true);
  });

  it("does NOT verify a stale marker recorded before verify-start", async () => {
    const since = 1_000_000;
    // Marker predates verify-start: an earlier verification's leftover must not
    // satisfy a fresh verify, even though the key still matches.
    mocks.prisma.webhookValidationReceipt.findUnique.mockResolvedValue(
      receiptRow(KEY, new Date(since - 1)),
    );

    const result = await checkXeroWebhookFreshVerify(since);

    expect(result.freshVerified).toBe(false);
    expect(result.keyMatches).toBe(true); // key still matches — only freshness fails
  });

  it("treats a marker AT exactly verify-start as stale (strictly newer required)", async () => {
    const since = 1_000_000;
    mocks.prisma.webhookValidationReceipt.findUnique.mockResolvedValue(
      receiptRow(KEY, new Date(since)),
    );

    const result = await checkXeroWebhookFreshVerify(since);

    expect(result.freshVerified).toBe(false);
  });

  it("does NOT verify a fresh marker recorded under a PREVIOUS/replaced key", async () => {
    const since = 1_000_000;
    // Timestamp is fresh, but the marker was signed with a different key — a
    // replaced webhook key must re-arm verification.
    mocks.prisma.webhookValidationReceipt.findUnique.mockResolvedValue(
      receiptRow(OTHER_KEY, new Date(since + 5_000)),
    );

    const result = await checkXeroWebhookFreshVerify(since);

    expect(result.freshVerified).toBe(false);
    expect(result.keyMatches).toBe(false);
    expect(result.verified).toBe(false);
  });

  it("never verifies without a server-issued verify-start (since = null)", async () => {
    mocks.prisma.webhookValidationReceipt.findUnique.mockResolvedValue(
      receiptRow(KEY, new Date(2_000_000)),
    );

    const result = await checkXeroWebhookFreshVerify(null);

    expect(result.freshVerified).toBe(false);
    expect(result.keyMatches).toBe(true); // persistent match, but not "fresh"
  });

  it("reports not-configured (never green) when no webhook key is stored", async () => {
    mocks.getOperationalXeroWebhookKey.mockResolvedValue(undefined);
    mocks.prisma.webhookValidationReceipt.findUnique.mockResolvedValue(
      receiptRow(KEY, new Date(Date.now() + 5_000)),
    );

    const result = await checkXeroWebhookFreshVerify(Date.now());

    expect(result.webhookKeyConfigured).toBe(false);
    expect(result.freshVerified).toBe(false);
    expect(result.verified).toBe(false);
  });

  it("exposes serverNow so the client can anchor verify-start to the server clock", async () => {
    mocks.prisma.webhookValidationReceipt.findUnique.mockResolvedValue(null);
    const result = await checkXeroWebhookFreshVerify(null, 1_234_567);
    expect(result.serverNow).toBe(1_234_567);
  });

  it("keeps the poll window comfortably above C1's 45s cache TTL", () => {
    expect(WEBHOOK_VERIFY_WINDOW_MS).toBeGreaterThan(45_000);
  });

  // --- Persistent badge state (the `verified` field drives the amber badge) --

  it("badge state (verified) is true and dated when a marker matches the current key", async () => {
    mocks.prisma.webhookValidationReceipt.findUnique.mockResolvedValue(
      receiptRow(KEY, new Date("2026-07-22T09:00:00.000Z")),
    );

    // The amber badge reads `verified` (persistent match), NOT freshness.
    const result = await checkXeroWebhookFreshVerify(null);

    expect(result.webhookKeyConfigured).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.lastValidatedAt).toBe("2026-07-22T09:00:00.000Z");
  });
});
