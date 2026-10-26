import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInvoiceObservationCursor, readInvoiceObservationCursor } from "@/lib/booking-invoice-observation-cursor";
const scope = { actorId: "synthetic-actor", bookingId: "synthetic-booking", tenantId: "synthetic-tenant", revision: "identity-revision" };
beforeEach(() => vi.stubEnv("AUTH_SECRET", "synthetic-observation-secret-over-32-characters"));
afterEach(() => vi.unstubAllEnvs());
describe("bounded invoice continuation scope", () => {
  it("round-trips the server's offset without disclosing the bound identities", () => {
    const cursor = createInvoiceObservationCursor(scope, 20);
    expect(readInvoiceObservationCursor(cursor, scope, 21)).toBe(20);
    const body = Buffer.from(cursor.split(".")[0]!, "base64url").toString("utf8");
    expect(body).not.toContain(scope.actorId); expect(body).not.toContain(scope.tenantId);
  });
  it.each(["actorId", "bookingId", "tenantId", "revision"] as const)("rejects a different %s", (key) => {
    expect(readInvoiceObservationCursor(createInvoiceObservationCursor(scope, 20), { ...scope, [key]: "different" }, 21)).toBeNull();
  });
  it.each([0, -1, 21, 20.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid signed offset %s", (offset) => {
    expect(readInvoiceObservationCursor(createInvoiceObservationCursor(scope, offset), scope, 21)).toBeNull();
  });
  it("rejects tampering, malformed signatures and an overlong cursor", () => {
    const cursor = createInvoiceObservationCursor(scope, 20);
    const [body, sig] = cursor.split(".");
    for (const candidate of [`${body}.`, `${body}.${sig}x`, `${body}x.${sig}`, `${cursor}.extra`, "x".repeat(2001)]) {
      expect(readInvoiceObservationCursor(candidate, scope, 21)).toBeNull();
    }
  });
  it("refuses an unavailable signing secret and a cursor from the prior secret", () => {
    const cursor = createInvoiceObservationCursor(scope, 20);
    vi.stubEnv("AUTH_SECRET", "another-synthetic-secret-over-32-characters");
    expect(readInvoiceObservationCursor(cursor, scope, 21)).toBeNull();
    vi.stubEnv("AUTH_SECRET", "short");
    expect(() => createInvoiceObservationCursor(scope, 20)).toThrow("unavailable");
    expect(readInvoiceObservationCursor(cursor, scope, 21)).toBeNull();
  });
});
