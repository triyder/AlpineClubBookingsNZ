import { describe, expect, it } from "vitest";
import {
  financeAccessLevelFromAccessRoles,
  legacyRoleFromAccessRoles,
  normalizeAssignableAccessRoles,
  resolveAccessRoles,
} from "@/lib/access-roles";

describe("access role compatibility helpers", () => {
  it("maps legacy member and finance fields to additive access roles", () => {
    expect(
      resolveAccessRoles({
        role: "USER",
        financeAccessLevel: "MANAGER",
        canLogin: true,
      }),
    ).toEqual(["USER", "FINANCE_ADMIN"]);
    expect(resolveAccessRoles({ role: "SCHOOL", canLogin: true })).toEqual([
      "ORG",
    ]);
    expect(resolveAccessRoles({ role: "SCHOOL", canLogin: false })).toEqual(
      [],
    );
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

  it("clears access roles for non-login records", () => {
    expect(
      normalizeAssignableAccessRoles(["USER", "FINANCE_ADMIN"], {
        canLogin: false,
      }),
    ).toEqual([]);
  });
});
