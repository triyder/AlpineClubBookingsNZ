import { beforeEach, describe, expect, it, vi } from "vitest";

// #4409: the Backups setup wizard's resume cursor, under the support area -
// support view to read, support edit to write - and only the "backup" id.
const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getProgress: vi.fn(),
  saveProgress: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/integration-wizard-progress", () => ({
  getIntegrationWizardProgress: mocks.getProgress,
  saveIntegrationWizardProgress: mocks.saveProgress,
}));

import { GET, POST } from "@/app/api/admin/backups/wizard-progress/route";
import { wizardProgressPath } from "@/lib/integration-wizard-progress-routes";

const URL_BASE = "http://localhost/api/admin/backups/wizard-progress";
const okGuard = () => ({ ok: true as const, session: { user: { id: "admin-1" } } });
const post = (body: unknown) => POST(new Request(URL_BASE, { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue(okGuard());
});

describe("backups wizard-progress (#4409)", () => {
  it("reads the Backups cursor under support view", async () => {
    mocks.getProgress.mockResolvedValue(null);
    const res = await GET(new Request(`${URL_BASE}?wizardId=backup`));
    expect(res.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "support", level: "view" } });
    expect(mocks.getProgress).toHaveBeenCalledWith("backup");
  });

  it("saves the Backups cursor under support edit", async () => {
    mocks.saveProgress.mockResolvedValue({ wizardId: "backup", currentStepId: "destination", completedStepIds: [] });
    const res = await post({ wizardId: "backup", currentStepId: "destination", completedStepIds: ["intro"] });
    expect(res.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "support", level: "edit" } });
    expect(mocks.saveProgress).toHaveBeenCalledWith(
      expect.objectContaining({ wizardId: "backup", currentStepId: "destination", updatedByMemberId: "admin-1" }),
    );
  });

  it.each(["xero", "stripe", "google", "display", "constructor", "__proto__", "toString"])(
    "refuses the %s id: a support gate never reaches another wizard's cursor",
    async (wizardId) => {
      const read = await GET(new Request(`${URL_BASE}?wizardId=${wizardId}`));
      expect(read.status).toBe(400);
      const write = await post({ wizardId, currentStepId: "x", completedStepIds: [] });
      expect(write.status).toBe(400);
      expect(mocks.getProgress).not.toHaveBeenCalled();
      expect(mocks.saveProgress).not.toHaveBeenCalled();
    },
  );

  it("answers the guard's refusal before reading or parsing anything", async () => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: new Response("unauthorised", { status: 401 }) });
    expect((await GET(new Request(`${URL_BASE}?wizardId=backup`))).status).toBe(401);
    expect((await POST(new Request(URL_BASE, { method: "POST", body: "{not json" }))).status).toBe(401);
    expect(mocks.getProgress).not.toHaveBeenCalled();
    expect(mocks.saveProgress).not.toHaveBeenCalled();
  });

  it("no wizard id is stored by two routes (each id has exactly one gate)", async () => {
    const { WIZARD_PROGRESS_ROUTES } = await import("@/lib/integration-wizard-progress-routes");
    const ids = Object.values(WIZARD_PROGRESS_ROUTES).flatMap((route) => [...route.wizardIds]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is where the client hook sends the Backups wizard, and only it", () => {
    expect(wizardProgressPath("backup")).toBe("/api/admin/backups/wizard-progress");
    for (const id of ["xero", "stripe", "google", "display", "unknown"]) {
      expect(wizardProgressPath(id)).toBe("/api/admin/integrations/wizard-progress");
    }
  });
});
