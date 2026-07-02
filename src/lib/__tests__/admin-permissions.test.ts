import { describe, expect, it } from "vitest";
import {
  canViewAdminHref,
  getAdminPermissionLevel,
  getAdminPermissionMatrix,
  getAdminRouteRequirement,
  hasAdminAreaAccess,
  hasAdminPortalAccess,
} from "@/lib/admin-permissions";

describe("admin permission bundles", () => {
  it("gives full admins edit access everywhere", () => {
    const matrix = getAdminPermissionMatrix({
      accessRoles: [{ role: "ADMIN" }],
      canLogin: true,
    });

    expect(Object.values(matrix).every((level) => level === "edit")).toBe(true);
    expect(hasAdminPortalAccess({ accessRoles: ["ADMIN"] })).toBe(true);
  });

  it("keeps read-only admin users at view access", () => {
    expect(
      getAdminPermissionLevel({ accessRoles: ["ADMIN_READONLY"] }, "bookings"),
    ).toBe("view");
    expect(
      hasAdminAreaAccess(
        { accessRoles: ["ADMIN_READONLY"] },
        { area: "bookings", level: "edit" },
      ),
    ).toBe(false);
  });

  it("merges bundled roles into a custom composed permission set", () => {
    const subject = {
      accessRoles: ["ADMIN_MEMBERSHIP", "ADMIN_CONTENT"],
      canLogin: true,
    };

    expect(getAdminPermissionLevel(subject, "membership")).toBe("edit");
    expect(getAdminPermissionLevel(subject, "content")).toBe("edit");
    expect(getAdminPermissionLevel(subject, "bookings")).toBe("view");
    expect(getAdminPermissionLevel(subject, "finance")).toBe("view");
  });

  it("keeps finance viewers out of the admin portal while allowing treasurers", () => {
    expect(hasAdminPortalAccess({ accessRoles: ["FINANCE_USER"] })).toBe(false);
    expect(hasAdminPortalAccess({ accessRoles: ["FINANCE_ADMIN"] })).toBe(true);
    expect(
      hasAdminAreaAccess(
        { accessRoles: ["FINANCE_ADMIN"] },
        { area: "finance", level: "edit" },
      ),
    ).toBe(true);
  });
});

describe("admin route requirements", () => {
  it("maps admin pages to view-level area access", () => {
    expect(getAdminRouteRequirement("/admin/members/123", "GET")).toEqual({
      area: "membership",
      level: "view",
    });
    expect(
      canViewAdminHref({ accessRoles: ["ADMIN_CONTENT"] }, "/admin/page-content"),
    ).toBe(true);
    expect(
      canViewAdminHref({ accessRoles: ["ADMIN_CONTENT"] }, "/admin/members"),
    ).toBe(false);
  });

  it("maps mutating admin API methods to edit access", () => {
    expect(getAdminRouteRequirement("/api/admin/page-content", "POST")).toEqual({
      area: "content",
      level: "edit",
    });
    expect(
      getAdminRouteRequirement("/api/admin/members/member-1/xero-link", "POST"),
    ).toEqual({
      area: "finance",
      level: "edit",
    });
  });

  it("keeps real admin APIs in their intended areas instead of overview fallback", () => {
    expect(
      getAdminRouteRequirement(
        "/api/admin/membership-cancellation-requests",
        "GET",
      ),
    ).toEqual({
      area: "membership",
      level: "view",
    });
    expect(
      getAdminRouteRequirement("/api/admin/induction-templates", "POST"),
    ).toEqual({
      area: "membership",
      level: "edit",
    });
    expect(
      getAdminRouteRequirement("/api/admin/email-failures/failure-1/review", "POST"),
    ).toEqual({
      area: "support",
      level: "edit",
    });
  });

  it("treats state-changing provider GET endpoints as edit access", () => {
    expect(getAdminRouteRequirement("/api/admin/xero/callback", "GET")).toEqual({
      area: "finance",
      level: "edit",
    });
  });
});
