import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fork #118: the admin work-party routes keep the Events Calendar in step —
 * create syncs (the module decides inside the helper), edit regenerates a
 * linked work party, delete removes the entries first, and "Add to calendar"
 * links an existing one while the calendar module is on.
 */
const h = vi.hoisted(() => ({
  modules: { eventsCalendar: true },
  syncCreated: vi.fn(async () => null as string | null),
  syncUpdated: vi.fn(async () => null as string | null),
  remove: vi.fn(async () => undefined),
  replace: vi.fn(async () => 3),
  createWorkParty: vi.fn(),
  updateWorkParty: vi.fn(),
  prisma: {
    lodge: { findUnique: vi.fn() },
    workPartyEvent: { findUnique: vi.fn(), delete: vi.fn() },
    promoCode: { delete: vi.fn() },
    $transaction: vi.fn(),
  },
  logAudit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: vi.fn(async () => ({
    ok: true,
    session: { user: { id: "admin-1" } },
  })),
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn(async () => h.modules),
}));
vi.mock("@/lib/calendar-service", () => ({
  replaceWorkPartyCalendarEvents: h.replace,
}));
vi.mock("@/lib/work-party-calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/work-party-calendar")>()),
  syncCreatedWorkPartyCalendar: h.syncCreated,
  syncUpdatedWorkPartyCalendar: h.syncUpdated,
  removeWorkPartyCalendar: h.remove,
}));
vi.mock("@/lib/work-party", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/work-party")>()),
  createWorkPartyEventWithPromo: h.createWorkParty,
  updateWorkPartyEventAndPromo: h.updateWorkParty,
}));

import { POST as createRoute } from "../route";
import { DELETE as deleteRoute, PUT as updateRoute } from "../[id]/route";
import { POST as addToCalendarRoute } from "../[id]/calendar/route";

const body = {
  name: "Spring",
  description: "Bring gloves",
  startDate: "2026-07-10",
  endDate: "2026-07-12",
  discountPercent: 50,
  active: true,
  lodgeId: "lodge-1",
};
const saved = {
  id: "wp-1",
  name: "Spring",
  description: "Bring gloves",
  startDate: new Date("2026-07-10T00:00:00.000Z"),
  endDate: new Date("2026-07-12T00:00:00.000Z"),
  discountPercent: 50,
  active: true,
  lodgeId: "lodge-1",
  promoCodeId: "promo-1",
};
const params = Promise.resolve({ id: "wp-1" });

function json(method: string, payload?: unknown) {
  return new Request("http://localhost/api/admin/work-parties", {
    method,
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.modules.eventsCalendar = true;
  h.prisma.lodge.findUnique.mockResolvedValue({ active: true, name: "Main Lodge" });
  h.createWorkParty.mockResolvedValue(saved);
  h.updateWorkParty.mockResolvedValue(saved);
  h.prisma.workPartyEvent.findUnique.mockResolvedValue({
    ...saved,
    lodge: { name: "Main Lodge" },
    promoCode: { id: "promo-1", redemptions: [] },
  });
  h.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn(h.prisma),
  );
});

describe("create", () => {
  it("syncs the new work party, with its lodge name, and returns any warning", async () => {
    h.syncCreated.mockResolvedValueOnce("calendar failed");
    const res = await createRoute(json("POST", body));
    expect(res.status).toBe(201);
    expect(h.syncCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wp-1", lodge: { name: "Main Lodge" } }),
      "admin-1",
    );
    expect((await res.json()).calendarWarning).toBe("calendar failed");
  });
});

describe("edit", () => {
  it("syncs the updated work party", async () => {
    const res = await updateRoute(json("PUT", body), { params });
    expect(res.status).toBe(200);
    expect(h.syncUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wp-1", lodge: { name: "Main Lodge" } }),
      "admin-1",
    );
  });

  it("deactivating goes through the same sync, which writes nothing new", async () => {
    await updateRoute(json("PUT", { ...body, active: false }), { params });
    expect(h.syncUpdated).toHaveBeenCalledTimes(1);
    expect(h.replace).not.toHaveBeenCalled();
  });
});

describe("delete", () => {
  it("removes the calendar entries before deleting the work party", async () => {
    const res = await deleteRoute(json("DELETE"), { params });
    expect(res.status).toBe(200);
    expect(h.remove).toHaveBeenCalledWith("wp-1", "admin-1");
    expect(h.remove.mock.invocationCallOrder[0]).toBeLessThan(
      h.prisma.workPartyEvent.delete.mock.invocationCallOrder[0],
    );
  });

  it("leaves the calendar alone when the delete is refused", async () => {
    h.prisma.workPartyEvent.findUnique.mockResolvedValue({
      ...saved,
      promoCode: { id: "promo-1", redemptions: [{ id: "r-1" }] },
    });
    const res = await deleteRoute(json("DELETE"), { params });
    expect(res.status).toBe(400);
    expect(h.remove).not.toHaveBeenCalled();
  });
});

describe("Add to calendar", () => {
  it("links an existing work party while the calendar is on", async () => {
    const res = await addToCalendarRoute(json("POST"), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).entryCount).toBe(3);
    expect(h.replace).toHaveBeenCalledWith(
      "wp-1",
      expect.objectContaining({
        title: "Work party: Spring",
        location: "Main Lodge",
        days: ["2026-07-10", "2026-07-11", "2026-07-12"],
      }),
      "admin-1",
    );
    expect(h.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workparty.calendar.add" }),
    );
  });

  it("is refused while the calendar module is off", async () => {
    h.modules.eventsCalendar = false;
    const res = await addToCalendarRoute(json("POST"), { params });
    expect(res.status).toBe(409);
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("404s an unknown work party", async () => {
    h.prisma.workPartyEvent.findUnique.mockResolvedValue(null);
    const res = await addToCalendarRoute(json("POST"), { params });
    expect(res.status).toBe(404);
    expect(h.replace).not.toHaveBeenCalled();
  });
});
