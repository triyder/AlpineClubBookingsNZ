import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: { member: { findUnique: vi.fn() } } }));
vi.mock("../_lib/load-booking-detail", () => ({ loadBookingDetail: vi.fn() }));
vi.mock("@/lib/booking-supplementary-invoice-identities", () => ({ readBookingSupplementaryInvoiceIdentities: vi.fn() }));
import { prisma } from "@/lib/prisma";
import { loadBookingDetail } from "../_lib/load-booking-detail";
import { readBookingSupplementaryInvoiceIdentities } from "@/lib/booking-supplementary-invoice-identities";
import { loadBookingOutstandingState } from "../_lib/booking-detail-outstanding";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
const booking = () => ({ id: "booking", memberId: "owner", member: { firstName: "Owner", lastName: "Proof" }, organisationId: null, organisation: null,
  status: "COMPLETED", deletedAt: null, organiserSettled: false, guests: [{ memberId: "guest" }], payment: null });
const reads = (actor = "owner") => ({ session: vi.fn(async () => ({ user: { id: actor, role: "MEMBER", accessRoles: ["ADMIN"], canLogin: true } }) as never),
  active: vi.fn(async () => null), modules: vi.fn(async () => ({ xeroIntegration: true }) as never),
  connection: vi.fn(async () => ({ connected: true, tenantId: "tenant", tokenExpiresAt: null, needsReentry: false })),
  format: vi.fn(async () => CLUB_FORMAT_TEST) });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadBookingDetail).mockResolvedValue(booking() as never);
  vi.mocked(prisma.member.findUnique).mockResolvedValue({ canLogin: true, accessRoles: [{ role: "USER", roleDefinition: null }] } as never);
  vi.mocked(readBookingSupplementaryInvoiceIdentities).mockResolvedValue({ invoiceIds: ["one"], incomplete: false, revision: "identity" });
});
describe("current booking financial audience before provider work", () => {
  it("uses the canonical active-session refusal before loading any financial data", async () => {
    const d = reads(); d.active.mockResolvedValue(new Response(null, { status: 403 }) as never);
    expect(await loadBookingOutstandingState("booking", "owner", d)).toBeNull();
    expect(loadBookingDetail).not.toHaveBeenCalled(); expect(readBookingSupplementaryInvoiceIdentities).not.toHaveBeenCalled();
  });
  it("rejects a mismatched session actor", async () => {
    const d = reads("other"); expect(await loadBookingOutstandingState("booking", "owner", d)).toBeNull();
    expect(d.active).not.toHaveBeenCalled(); expect(loadBookingDetail).not.toHaveBeenCalled();
  });
  it("replaces stale session admin claims with current DB roles before the guest money gate", async () => {
    const d = reads("guest"); const result = await loadBookingOutstandingState("booking", "guest", d);
    expect(result?.viewer.canSeeOwnerCredit).toBe(false); expect(result?.collectable).toBe(false);
    expect(readBookingSupplementaryInvoiceIdentities).not.toHaveBeenCalled(); expect(d.connection).not.toHaveBeenCalled(); expect(d.modules).not.toHaveBeenCalled();
  });
  it("admits a read-only officer who is also a guest through the same canonical viewer", async () => {
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ canLogin: true, accessRoles: [{ role: "ADMIN_READONLY", roleDefinition: null }] } as never);
    const result = await loadBookingOutstandingState("booking", "guest", reads("guest"));
    expect(result?.viewer.isLinkedGuestViewer).toBe(true); expect(result?.viewer.canSeeOwnerCredit).toBe(true); expect(result?.collectable).toBe(true);
    expect(readBookingSupplementaryInvoiceIdentities).toHaveBeenCalledWith("booking");
  });
  it.each(["CANCELLED", "BUMPED"])("stops %s before identities or token reads", async (status) => {
    vi.mocked(loadBookingDetail).mockResolvedValue({ ...booking(), status } as never);
    const d = reads(); expect((await loadBookingOutstandingState("booking", "owner", d))?.collectable).toBe(false);
    expect(readBookingSupplementaryInvoiceIdentities).not.toHaveBeenCalled(); expect(d.connection).not.toHaveBeenCalled();
  });
  it("stops a deleted booking before financial discovery even for an administrator", async () => {
    vi.mocked(loadBookingDetail).mockResolvedValue({ ...booking(), deletedAt: new Date("2026-06-01T00:00:00Z") } as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ canLogin: true, accessRoles: [{ role: "ADMIN", roleDefinition: null }] } as never);
    const d = reads(); expect((await loadBookingOutstandingState("booking", "owner", d))?.collectable).toBe(false);
    expect(readBookingSupplementaryInvoiceIdentities).not.toHaveBeenCalled(); expect(d.connection).not.toHaveBeenCalled();
  });
  it("invalidates the revision when module/connection eligibility changes and excludes organiser collection", async () => {
    const d = reads(); const first = await loadBookingOutstandingState("booking", "owner", d);
    d.connection.mockResolvedValue({ connected: false, tenantId: "tenant", tokenExpiresAt: null, needsReentry: true });
    const disconnected = await loadBookingOutstandingState("booking", "owner", d);
    expect(disconnected?.providerEligible).toBe(false); expect(disconnected?.revision).not.toBe(first?.revision);
    d.connection.mockResolvedValue({ connected: true, tenantId: "tenant", tokenExpiresAt: null, needsReentry: false });
    vi.mocked(loadBookingDetail).mockResolvedValue({ ...booking(), organiserSettled: true } as never);
    expect((await loadBookingOutstandingState("booking", "owner", d))?.providerEligible).toBe(false);
  });
});
