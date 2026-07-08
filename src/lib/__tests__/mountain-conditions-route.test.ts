import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  emptyWhakapapaCurlData,
  emptyWhakapapaSectionVisibility,
} from "@/lib/whakapapa-report";

// Regression coverage for PATCH /api/admin/mountain-conditions (PR #1581,
// #1657): the admin guard, invalid-body 400s, visibility persistence that
// preserves the cached report / fetchedAt / freeze window, and the
// PATCH-before-first-fetch fix that backdates fetchedAt so the public GET does
// not serve an empty-but-"fresh" row.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  fetchWhakapapaCurlData: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    whakapapaReportCache: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
    },
  },
}));

vi.mock("@/lib/whakapapa-report.server", () => ({
  fetchWhakapapaCurlData: mocks.fetchWhakapapaCurlData,
}));

import { PATCH } from "@/app/api/admin/mountain-conditions/route";

const ADMIN_USER = {
  id: "admin_1",
  role: "ADMIN",
  accessRoles: [{ role: "ADMIN" }],
};

function patchRequest(body: unknown, { raw = false } = {}) {
  return new NextRequest("http://localhost/api/admin/mountain-conditions", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

/** A fully-populated cached report to prove PATCH preserves the payload. */
function cachedReport() {
  const payload = emptyWhakapapaCurlData();
  payload.updated = "2026-07-08T00:00:00.000Z";
  payload.roadStatus = {
    name: "Bruce Road",
    status: "Open",
    wheelRequirements: "Chains carried",
    roadContent: "Sealed.",
  };
  payload.lifts = [{ name: "Sky Waka", status: "Open" }];
  payload.conditions = [
    {
      name: "Top",
      temperature: "-3",
      wind: "25 km/h",
      snowBase: "120 cm",
      snowfall24h: "5 cm",
      snowfall7d: "30 cm",
    },
  ];
  return payload;
}

describe("PATCH /api/admin/mountain-conditions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: ADMIN_USER });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    // Echo the written row back so toResponseRecord can serialize it. Both the
    // create and update branches carry identical values in this route, so the
    // update fields represent whatever was written.
    mocks.upsert.mockImplementation(async (args) => ({
      source: args.where.source,
      payload: args.update.payload,
      fetchedAt: args.update.fetchedAt,
      frozenUntil: args.update.frozenUntil,
      updatedAt: new Date("2026-07-08T12:00:00.000Z"),
    }));
  });

  it("returns 403 for a non-admin and never touches the cache", async () => {
    mocks.auth.mockResolvedValue({
      user: { id: "member_1", role: "MEMBER", accessRoles: [] },
    });

    const response = await PATCH(patchRequest({ visibility: { lifts: false } }));

    expect(response.status).toBe(403);
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("returns 401 when there is no session", async () => {
    mocks.auth.mockResolvedValue(null);

    const response = await PATCH(patchRequest({ visibility: { lifts: false } }));

    expect(response.status).toBe(401);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("returns 400 for a body that is not valid JSON", async () => {
    const response = await PATCH(patchRequest("{not json", { raw: true }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("returns 400 when the visibility object is missing or not an object", async () => {
    const missing = await PATCH(patchRequest({}));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: "visibility object is required",
    });

    const notObject = await PATCH(patchRequest({ visibility: "all" }));
    expect(notObject.status).toBe(400);

    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("persists visibility while preserving report data, fetchedAt, and frozenUntil", async () => {
    const fetchedAt = new Date("2026-07-08T09:00:00.000Z");
    const frozenUntil = new Date("2026-07-08T21:00:00.000Z");
    const payload = cachedReport();
    mocks.findUnique.mockResolvedValue({
      source: "whakapapa-report",
      payload,
      fetchedAt,
      frozenUntil,
      updatedAt: fetchedAt,
    });

    const response = await PATCH(
      patchRequest({ visibility: { conditions: false } }),
    );

    expect(response.status).toBe(200);
    const [args] = mocks.upsert.mock.calls[0];

    // The freeze window and fetch timestamp survive a visibility toggle...
    expect(args.update.fetchedAt).toBe(fetchedAt);
    expect(args.update.frozenUntil).toBe(frozenUntil);
    // ...as does the cached report data (only visibility changes).
    expect(args.update.payload.roadStatus).toEqual(payload.roadStatus);
    expect(args.update.payload.lifts).toEqual(payload.lifts);
    expect(args.update.payload.conditions).toEqual(payload.conditions);
    // Partial input is coerced: only `conditions` flips, the rest stay visible.
    expect(args.update.payload.visibility).toEqual({
      ...emptyWhakapapaSectionVisibility(),
      conditions: false,
    });

    const bodyRecord = (await response.json()).record;
    expect(bodyRecord.fetchedAt).toBe(fetchedAt.toISOString());
    expect(bodyRecord.frozenUntil).toBe(frozenUntil.toISOString());
  });

  it("backdates fetchedAt to the epoch when creating a visibility-only row (no prior fetch)", async () => {
    // #1657 fix: with no cache row, a naive PATCH would create one stamped
    // `now` with an empty payload, and the public GET would serve those empty
    // sections as "fresh" for the whole TTL window. Backdating fetchedAt marks
    // the row stale so the next public read fetches upstream.
    mocks.findUnique.mockResolvedValue(null);

    const response = await PATCH(
      patchRequest({ visibility: { lifts: false } }),
    );

    expect(response.status).toBe(200);
    const [args] = mocks.upsert.mock.calls[0];

    expect(args.create.fetchedAt.getTime()).toBe(0);
    expect(args.create.frozenUntil).toBeNull();
    // The payload is empty report data carrying only the new visibility.
    expect(args.create.payload.visibility).toEqual({
      ...emptyWhakapapaSectionVisibility(),
      lifts: false,
    });
    expect(args.create.payload.conditions).toEqual([]);

    // The serialized response advertises the stale (epoch) timestamp.
    const bodyRecord = (await response.json()).record;
    expect(bodyRecord.fetchedAt).toBe(new Date(0).toISOString());
  });
});
