import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CLUB_THEME_VALUES } from "@/lib/club-theme-schema";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  clubThemeFindUnique: vi.fn(),
  clubThemeUpsert: vi.fn(),
  auditLogCreate: vi.fn(),
  revalidatePath: vi.fn(),
  primeEmailPalette: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));

// #1912: the route re-primes the cached email brand palette after a save so
// emails pick up the new scheme immediately. Mock it to assert the wiring.
vi.mock("@/lib/email-theme", () => ({
  primeEmailPalette: mocks.primeEmailPalette,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTheme: {
      findUnique: mocks.clubThemeFindUnique,
      upsert: mocks.clubThemeUpsert,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
  },
}));

import { PUT } from "@/app/api/admin/site-style/route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/site-style", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("site style admin API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } },
    });
    mocks.clubThemeFindUnique.mockResolvedValue(null);
    mocks.clubThemeUpsert.mockImplementation(({ create, update }) =>
      Promise.resolve({
        ...(create ?? update),
        completedAt: create?.completedAt ?? update?.completedAt ?? null,
      }),
    );
    mocks.auditLogCreate.mockResolvedValue({});
    mocks.primeEmailPalette.mockResolvedValue(undefined);
  });

  it("rejects unsafe colour values before storage", async () => {
    const response = await PUT(
      request({
        ...DEFAULT_CLUB_THEME_VALUES,
        brandGold: "#ffcb05; color:red",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid input");
    expect(mocks.clubThemeUpsert).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects palettes that fail WCAG AA text contrast", async () => {
    const response = await PUT(
      request({
        ...DEFAULT_CLUB_THEME_VALUES,
        // brand-charcoal button text on a near-identical gold: unreadable.
        brandGold: "#33373e",
        brandCharcoal: "#30343b",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/contrast/i);
    expect(body.contrastWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "button-on-gold" }),
      ]),
    );
    expect(mocks.clubThemeUpsert).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects unreadable text on the light app secondary surface", async () => {
    const response = await PUT(
      request({
        ...DEFAULT_CLUB_THEME_VALUES,
        brandMist: DEFAULT_CLUB_THEME_VALUES.brandDeep,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.contrastWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "app-secondary-on-mist" }),
      ]),
    );
    expect(mocks.clubThemeUpsert).not.toHaveBeenCalled();
  });

  it("saves completion and revalidates every themed layout", async () => {
    const response = await PUT(
      request({
        ...DEFAULT_CLUB_THEME_VALUES,
        completeSetup: true,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.theme.completedAt).toEqual(expect.any(String));
    expect(mocks.clubThemeUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        create: expect.objectContaining({
          id: "default",
          completedAt: expect.any(Date),
        }),
      }),
    );
    expect(mocks.revalidatePath.mock.calls).toEqual([
      ["/(website)", "layout"],
      ["/(authenticated)", "layout"],
      ["/(admin)", "layout"],
    ]);
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });

  it("re-primes the email palette after a successful save so emails use the new scheme (#1912)", async () => {
    const response = await PUT(request({ ...DEFAULT_CLUB_THEME_VALUES }));

    expect(response.status).toBe(200);
    expect(mocks.clubThemeUpsert).toHaveBeenCalled();
    // The email brand palette is cached separately from the app-shell CSS, so
    // the save must explicitly refresh it or emails keep the old colours.
    expect(mocks.primeEmailPalette).toHaveBeenCalledTimes(1);
  });

  it("does not re-prime the email palette when the save is rejected (#1912)", async () => {
    const response = await PUT(
      request({ ...DEFAULT_CLUB_THEME_VALUES, brandGold: "not-a-colour" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.clubThemeUpsert).not.toHaveBeenCalled();
    expect(mocks.primeEmailPalette).not.toHaveBeenCalled();
  });
});
