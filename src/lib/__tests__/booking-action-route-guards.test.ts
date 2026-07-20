import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-focused tests for the booking action routes brought under explicit
// per-area permissions in #1997. Each route previously used a bare
// `requireAdmin()` and relied on path-inference; the explicit permission must
// match the area the route-area matrix already infers (bookings), so no matrix
// pin moves. We mock `requireAdmin` to a denial and assert (a) the exact
// permission each verb requests and (b) that the denial short-circuits with 403
// before any handler work.
const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn() }));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));

// Prisma is never reached on the denial path, but the modules import it at load
// time — a generic stub keeps the import graph happy without a real client.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
// Stripe/email pull in provider SDKs at import; stub them so the route modules
// load in the jsdom-free node test without provider env.
vi.mock("@/lib/stripe", () => ({ chargePaymentMethod: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendBookingConfirmedEmail: vi.fn() }));

import { PATCH as reviewPatch } from "@/app/api/admin/bookings/[id]/review/route";
import { POST as forceConfirmPost } from "@/app/api/admin/bookings/[id]/force-confirm/route";
import {
  POST as capacityHoldPost,
  DELETE as capacityHoldDelete,
} from "@/app/api/admin/bookings/[id]/capacity-hold/route";
import { POST as exclusiveHoldPost } from "@/app/api/admin/bookings/[id]/exclusive-hold/route";
import { POST as confirmPendingPost } from "@/app/api/admin/bookings/[id]/confirm-pending-guests/route";
import { POST as copyPost } from "@/app/api/admin/bookings/[id]/copy/route";
import {
  GET as changeRequestGet,
  PATCH as changeRequestPatch,
} from "@/app/api/admin/booking-change-requests/[id]/route";

const BOOKINGS_EDIT = { area: "bookings", level: "edit" } as const;
const BOOKINGS_VIEW = { area: "bookings", level: "view" } as const;

function forbidden() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

function req(method: string) {
  return new NextRequest("http://localhost/api/admin/bookings/b1/action", {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify({}),
  });
}

const params = Promise.resolve({ id: "b1" });

describe("booking action route guards (#1997)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: forbidden() });
  });

  it("review PATCH requires bookings:edit and 403s before work", async () => {
    const res = await reviewPatch(req("PATCH"), { params });
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: BOOKINGS_EDIT,
    });
  });

  it("force-confirm POST requires bookings:edit", async () => {
    const res = await forceConfirmPost(req("POST"), { params });
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: BOOKINGS_EDIT,
    });
  });

  it("capacity-hold POST requires bookings:edit", async () => {
    const res = await capacityHoldPost(req("POST"), { params });
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: BOOKINGS_EDIT,
    });
  });

  it("capacity-hold DELETE requires bookings:edit", async () => {
    const res = await capacityHoldDelete(req("DELETE"), { params });
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: BOOKINGS_EDIT,
    });
  });

  it("exclusive-hold POST requires bookings:edit", async () => {
    const res = await exclusiveHoldPost(req("POST"), { params });
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: BOOKINGS_EDIT,
    });
  });

  it("confirm-pending-guests POST requires bookings:edit", async () => {
    const res = await confirmPendingPost(req("POST"), { params });
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: BOOKINGS_EDIT,
    });
  });

  it("copy POST requires bookings:edit", async () => {
    const res = await copyPost(req("POST"), { params });
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: BOOKINGS_EDIT,
    });
  });

  it("booking-change-request GET requires bookings:view", async () => {
    const res = await changeRequestGet(req("GET"), { params });
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: BOOKINGS_VIEW,
    });
  });

  it("booking-change-request PATCH requires bookings:edit", async () => {
    const res = await changeRequestPatch(req("PATCH"), { params });
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: BOOKINGS_EDIT,
    });
  });
});
