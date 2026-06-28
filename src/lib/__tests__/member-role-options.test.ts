import { describe, expect, it } from "vitest";
import {
  ASSIGNABLE_ACCESS_ROLE_VALUES,
  getAccessRoleOptions,
  ROLE_VALUES,
} from "@/lib/member-roles";

describe("access role options", () => {
  it("offers only assignable access roles by default", () => {
    expect(ASSIGNABLE_ACCESS_ROLE_VALUES).toEqual([
      "MEMBER",
      "ADMIN",
      "LODGE",
    ]);
    expect(getAccessRoleOptions().map((option) => option.value)).toEqual([
      "MEMBER",
      "ADMIN",
      "LODGE",
    ]);
  });

  it("preserves legacy membership-category roles only for existing values", () => {
    expect(getAccessRoleOptions("ASSOCIATE").map((option) => option.value)).toEqual([
      "MEMBER",
      "ADMIN",
      "LODGE",
      "ASSOCIATE",
    ]);
    expect(getAccessRoleOptions("LIFE").map((option) => option.value)).toEqual([
      "MEMBER",
      "ADMIN",
      "LODGE",
      "LIFE",
    ]);
    expect(
      getAccessRoleOptions("LIFE").find((option) => option.value === "LIFE"),
    ).toMatchObject({
      label: "Life Member (legacy category)",
      legacyMembershipCategory: true,
    });
  });

  it("keeps the database role enum compatible without adding committee roles", () => {
    expect(ROLE_VALUES).toEqual([
      "MEMBER",
      "ADMIN",
      "LODGE",
      "ASSOCIATE",
      "LIFE",
    ]);
    expect(ROLE_VALUES).not.toContain("COMMITTEE");
  });
});
