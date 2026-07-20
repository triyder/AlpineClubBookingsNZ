import { describe, expect, it } from "vitest";
import { resolvePostLoginLandingPath } from "@/lib/post-login-landing";
import {
  ADMIN_PERMISSION_AREAS,
  type AdminPermissionInput,
  type AdminPermissionLevel,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

function matrix(
  overrides: Partial<AdminPermissionMatrix> = {},
): AdminPermissionMatrix {
  const base = Object.fromEntries(
    ADMIN_PERMISSION_AREAS.map((area) => [area.key, "none"]),
  ) as Record<string, AdminPermissionLevel>;
  return { ...base, ...overrides } as AdminPermissionMatrix;
}

function withMatrix(m: AdminPermissionMatrix): AdminPermissionInput {
  return { adminPermissionMatrix: m };
}

// A Full-Admin-style matrix (overview editable → first accessible = dashboard).
const FULL_ADMIN = withMatrix(
  matrix({
    overview: "edit",
    bookings: "edit",
    membership: "edit",
    finance: "edit",
    lodge: "edit",
    content: "edit",
    support: "edit",
  }),
);

// An admin whose overview area is denied but who can still reach bookings — the
// case that makes a literal /admin/dashboard wrong (D-D3).
const BOOKINGS_ONLY_ADMIN = withMatrix(
  matrix({ overview: "none", bookings: "edit" }),
);

// A plain member — no accessible admin area.
const NON_ADMIN = withMatrix(matrix());

describe("resolvePostLoginLandingPath — role default (no preference)", () => {
  it("sends an admin to their first accessible admin page", () => {
    expect(
      resolvePostLoginLandingPath({
        landingPreference: null,
        permissionInput: FULL_ADMIN,
      }),
    ).toBe("/admin/dashboard");
  });

  it("sends an admin whose overview is denied to their first accessible page (no guard bounce)", () => {
    expect(
      resolvePostLoginLandingPath({
        landingPreference: null,
        permissionInput: BOOKINGS_ONLY_ADMIN,
      }),
    ).toBe("/admin/bookings");
  });

  it("keeps a non-admin on /dashboard", () => {
    expect(
      resolvePostLoginLandingPath({
        landingPreference: null,
        permissionInput: NON_ADMIN,
      }),
    ).toBe("/dashboard");
  });
});

describe("resolvePostLoginLandingPath — explicit preference", () => {
  it("MEMBER_DASHBOARD pins /dashboard even for an admin", () => {
    expect(
      resolvePostLoginLandingPath({
        landingPreference: "MEMBER_DASHBOARD",
        permissionInput: FULL_ADMIN,
      }),
    ).toBe("/dashboard");
  });

  it("ADMIN_DASHBOARD resolves to the first accessible admin page, not a literal /admin/dashboard", () => {
    expect(
      resolvePostLoginLandingPath({
        landingPreference: "ADMIN_DASHBOARD",
        permissionInput: BOOKINGS_ONLY_ADMIN,
      }),
    ).toBe("/admin/bookings");
  });

  it("a demoted admin holding a stale ADMIN_DASHBOARD preference lands safely on /dashboard", () => {
    expect(
      resolvePostLoginLandingPath({
        landingPreference: "ADMIN_DASHBOARD",
        permissionInput: NON_ADMIN,
      }),
    ).toBe("/dashboard");
  });

  it("a non-admin with any preference stays on /dashboard", () => {
    for (const pref of [null, "MEMBER_DASHBOARD", "ADMIN_DASHBOARD"] as const) {
      expect(
        resolvePostLoginLandingPath({
          landingPreference: pref,
          permissionInput: NON_ADMIN,
        }),
      ).toBe("/dashboard");
    }
  });
});

describe("resolvePostLoginLandingPath — explicit callbackUrl precedence (D-D4)", () => {
  it("a genuinely explicit safe callbackUrl wins over the preference and role default", () => {
    // admin + MEMBER_DASHBOARD, non-admin, admin + no pref: explicit always wins
    expect(
      resolvePostLoginLandingPath({
        explicitCallbackUrl: "/bookings/123",
        landingPreference: "MEMBER_DASHBOARD",
        permissionInput: FULL_ADMIN,
      }),
    ).toBe("/bookings/123");
    expect(
      resolvePostLoginLandingPath({
        explicitCallbackUrl: "/nominations/tok",
        landingPreference: null,
        permissionInput: NON_ADMIN,
      }),
    ).toBe("/nominations/tok");
  });

  it("a /login-shaped callbackUrl (a flow-materialised detour URL) is NOT explicit and falls through to the role default", () => {
    expect(
      resolvePostLoginLandingPath({
        explicitCallbackUrl: "/login?callbackUrl=%2Fadmin",
        landingPreference: null,
        permissionInput: FULL_ADMIN,
      }),
    ).toBe("/admin/dashboard");
  });

  it("rejects open-redirect attempts and falls through to the role default", () => {
    for (const attempt of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      " /dashboard",
    ]) {
      expect(
        resolvePostLoginLandingPath({
          explicitCallbackUrl: attempt,
          landingPreference: null,
          permissionInput: FULL_ADMIN,
        }),
      ).toBe("/admin/dashboard");
    }
  });
});
