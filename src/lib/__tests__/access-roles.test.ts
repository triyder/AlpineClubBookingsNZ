import { describe, expect, it } from "vitest";
import {
  accessRolesFromCompatibilityFields,
  authorizationRoleFromAccessRoles,
  financeAccessLevelFromAccessRoles,
  legacyRoleFromAccessRoles,
  normalizeAssignableAccessRoles,
  resolveAccessRoles,
} from "@/lib/access-roles";

describe("access role compatibility helpers", () => {
  it("maps legacy member and finance fields only through the compatibility helper", () => {
    expect(
      accessRolesFromCompatibilityFields({
        role: "USER",
        financeAccessLevel: "MANAGER",
        canLogin: true,
      }),
    ).toEqual(["USER", "FINANCE_ADMIN"]);
    expect(accessRolesFromCompatibilityFields({ role: "SCHOOL", canLogin: true })).toEqual([
      "ORG",
    ]);
    expect(accessRolesFromCompatibilityFields({ role: "SCHOOL", canLogin: false })).toEqual([]);
  });

  it("does not authorize from legacy fields in runtime access resolution", () => {
    expect(
      resolveAccessRoles({
        role: "ADMIN",
        financeAccessLevel: "MANAGER",
        canLogin: true,
      }),
    ).toEqual([]);
    expect(
      resolveAccessRoles({
        accessRoles: [{ role: "ADMIN" }, { role: "FINANCE_ADMIN" }],
        role: "USER",
        financeAccessLevel: "NONE",
        canLogin: true,
      }),
    ).toEqual(["ADMIN", "FINANCE_ADMIN"]);
  });

  it("normalizes explicit role lists before writing compatibility fields", () => {
    const roles = normalizeAssignableAccessRoles(
      ["USER", "FINANCE_USER", "FINANCE_ADMIN", "USER"],
      { canLogin: true },
    );

    expect(roles).toEqual(["USER", "FINANCE_ADMIN"]);
    expect(legacyRoleFromAccessRoles(roles)).toBe("USER");
    expect(financeAccessLevelFromAccessRoles(roles)).toBe("MANAGER");
  });

  it("projects a runtime authorization role from access role rows only", () => {
    expect(
      authorizationRoleFromAccessRoles({
        role: "USER",
        accessRoles: [{ role: "ADMIN" }],
      }),
    ).toBe("ADMIN");
    expect(
      authorizationRoleFromAccessRoles({
        role: "ADMIN",
        accessRoles: [{ role: "USER" }],
      }),
    ).toBe("USER");
    expect(
      authorizationRoleFromAccessRoles({
        role: "ADMIN",
        financeAccessLevel: "MANAGER",
        accessRoles: [],
      }),
    ).toBe("USER");
  });

  it("clears access roles for non-login records", () => {
    expect(
      normalizeAssignableAccessRoles(["USER", "FINANCE_ADMIN"], {
        canLogin: false,
      }),
    ).toEqual([]);
  });
});
