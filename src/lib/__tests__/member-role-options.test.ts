import { describe, expect, it } from "vitest";
import {
  ASSIGNABLE_ACCESS_ROLE_VALUES,
  getAccessRoleOptions,
  ROLE_VALUES,
} from "@/lib/member-roles";

describe("access role options", () => {
  it("offers assignable access roles plus the non-member categories by default", () => {
    expect(ASSIGNABLE_ACCESS_ROLE_VALUES).toEqual([
      "MEMBER",
      "ADMIN",
      "LODGE",
    ]);
    expect(getAccessRoleOptions().map((option) => option.value)).toEqual([
      "MEMBER",
      "ADMIN",
      "LODGE",
      "NON_MEMBER",
      "SCHOOL",
    ]);
  });

  it("labels the non-member categories and flags them as non-member", () => {
    const options = getAccessRoleOptions();
    expect(options.find((option) => option.value === "NON_MEMBER")).toMatchObject({
      label: "Non-Member",
      nonMember: true,
      legacyMembershipCategory: false,
    });
    expect(options.find((option) => option.value === "SCHOOL")).toMatchObject({
      label: "School",
      nonMember: true,
      legacyMembershipCategory: false,
    });
  });

  it("preserves legacy membership-category roles only for existing values", () => {
    expect(getAccessRoleOptions("ASSOCIATE").map((option) => option.value)).toEqual([
      "MEMBER",
      "ADMIN",
      "LODGE",
      "ASSOCIATE",
      "NON_MEMBER",
      "SCHOOL",
    ]);
    expect(getAccessRoleOptions("LIFE").map((option) => option.value)).toEqual([
      "MEMBER",
      "ADMIN",
      "LODGE",
      "LIFE",
      "NON_MEMBER",
      "SCHOOL",
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
      "NON_MEMBER",
      "SCHOOL",
    ]);
    expect(ROLE_VALUES).not.toContain("COMMITTEE");
  });
});
