import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/session-guards", () => ({ requireActiveSession: vi.fn() }));
vi.mock("@/app/(authenticated)/bookings/[id]/_lib/booking-detail-outstanding", () => ({ readBookingOutstandingAction: vi.fn() }));
import { requireActiveSession } from "@/lib/session-guards";
import { readBookingOutstandingAction } from "@/app/(authenticated)/bookings/[id]/_lib/booking-detail-outstanding";
import { GET } from "../route";
const read = (cursor = "signed-cursor") => GET(new NextRequest(`http://localhost/api/bookings/booking/additional-payment-observations?${new URLSearchParams({ cursor })}`), { params: Promise.resolve({ id: "booking" }) });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireActiveSession).mockResolvedValue({ ok: true, session: { user: { id: "actor" } } } as never);
  vi.mocked(readBookingOutstandingAction).mockResolvedValue({ view: { kind: "hidden" }, state: { privateBooking: "never serialized" } } as never);
});
describe("authenticated supplementary invoice continuation", () => {
  it("preserves the canonical session refusal before any booking/provider read", async () => {
    vi.mocked(requireActiveSession).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }) });
    expect((await read()).status).toBe(401); expect(readBookingOutstandingAction).not.toHaveBeenCalled();
  });
  it.each(["", "x".repeat(2001)])("rejects invalid continuation shape before the reader", async (cursor) => {
    expect((await read(cursor)).status).toBe(400); expect(readBookingOutstandingAction).not.toHaveBeenCalled();
  });
  it("takes actor authority from the session and serializes only the authorized view", async () => {
    const response = await read();
    expect(readBookingOutstandingAction).toHaveBeenCalledWith("booking", "actor", "signed-cursor");
    expect(await response.json()).toEqual({ kind: "hidden" }); expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("distinguishes an unavailable authority read from a valid hidden view", async () => {
    vi.mocked(readBookingOutstandingAction).mockRejectedValue(new Error("unavailable"));
    const response = await read();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Invoice observations unavailable" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
