import { describe, expect, it } from "vitest";
import {
  buildInitialRequestNotificationParents,
  buildInitialRequestSelections,
  buildSharedEmailClusters,
  getFamilyGroupRequestSummary,
  getFamilyGroupRequestTypeLabel,
  mapFamilyGroupRequestSearchResults,
  type FamilyGroupMemberRow,
  type FamilyGroupRequest,
} from "@/lib/admin-family-group-ui-helpers";

const baseRequest: FamilyGroupRequest = {
  id: "request-1",
  type: "CHILD_REQUEST",
  createdAt: "2026-05-01T00:00:00.000Z",
  requester: {
    id: "parent-1",
    firstName: "Ada",
    lastName: "Parent",
    email: "ada@example.com",
  },
  familyGroup: {
    id: "group-1",
    name: "Parent Family",
    members: [
      {
        id: "parent-1",
        firstName: "Ada",
        lastName: "Parent",
        email: "ada@example.com",
        ageTier: "ADULT",
      },
    ],
  },
  childFirstName: "Bea",
  childLastName: "Child",
  childDateOfBirth: "2018-01-01",
  matchingMembers: [
    {
      id: "child-1",
      firstName: "Bea",
      lastName: "Child",
      email: "ada@example.com",
      ageTier: "CHILD",
      active: true,
      canLogin: false,
      dateOfBirth: "2018-01-01",
      alreadyInGroup: false,
      parentLinks: [],
    },
  ],
};

describe("admin-family-group-ui-helpers", () => {
  it("defaults child request selections and notification parents", () => {
    expect(buildInitialRequestSelections([baseRequest], {})).toEqual({
      "request-1": "child-1",
    });
    expect(buildInitialRequestNotificationParents([baseRequest], {})).toEqual({
      "request-1": "parent-1",
    });
  });

  it("defaults same-email adult requests to create when no matches exist", () => {
    const adultRequest: FamilyGroupRequest = {
      ...baseRequest,
      id: "request-2",
      type: "ADULT_REQUEST",
      childFirstName: null,
      childLastName: null,
      requestedFirstName: "Carla",
      requestedLastName: "Adult",
      requestedEmail: "ada@example.com",
      matchingMembers: [],
    };

    expect(buildInitialRequestSelections([adultRequest], {})).toEqual({
      "request-2": "__create__",
    });
  });

  it("maps search results with child age-tier filtering and group membership flags", () => {
    const results = mapFamilyGroupRequestSearchResults(baseRequest, [
      {
        id: "child-2",
        firstName: "Bea",
        lastName: "Child",
        email: "bea@example.com",
        ageTier: "CHILD",
        active: true,
        canLogin: false,
        dateOfBirth: "2018-01-01",
      },
      {
        id: "parent-1",
        firstName: "Ada",
        lastName: "Parent",
        email: "ada@example.com",
        ageTier: "ADULT",
        active: true,
        canLogin: true,
      },
    ]);

    expect(results).toEqual([
      {
        id: "child-2",
        firstName: "Bea",
        lastName: "Child",
        email: "bea@example.com",
        ageTier: "CHILD",
        active: true,
        canLogin: false,
        dateOfBirth: "2018-01-01",
        parentLinks: [],
        alreadyInGroup: false,
      },
    ]);
  });

  it("builds shared-email clusters using effective email", () => {
    const members: FamilyGroupMemberRow[] = [
      {
        id: "adult-1",
        firstName: "Ada",
        lastName: "Parent",
        email: "ADA@EXAMPLE.COM",
        effectiveEmail: "ada@example.com",
        ageTier: "ADULT",
        active: true,
      },
      {
        id: "child-1",
        firstName: "Bea",
        lastName: "Child",
        email: "child@example.com",
        effectiveEmail: "ada@example.com",
        ageTier: "CHILD",
        active: true,
      },
      {
        id: "adult-2",
        firstName: "Cora",
        lastName: "Other",
        email: "cora@example.com",
        ageTier: "ADULT",
        active: true,
      },
    ];

    expect(buildSharedEmailClusters(members)).toEqual([
      {
        email: "ada@example.com",
        members: [members[0], members[1]],
      },
    ]);
  });

  it("summarizes removal requests with the subject member", () => {
    const removalRequest: FamilyGroupRequest = {
      ...baseRequest,
      id: "request-3",
      type: "REMOVAL_REQUEST",
      subjectMember: {
        id: "child-1",
        firstName: "Bea",
        lastName: "Child",
        email: "bea@example.com",
        ageTier: "CHILD",
        active: true,
      },
      matchingMembers: [],
    };

    expect(getFamilyGroupRequestSummary(removalRequest)).toBe(
      "Ada Parent wants to remove Bea Child from Parent Family."
    );
  });

  it("labels and summarizes GROUP_CREATE requests (#1681)", () => {
    const groupCreateRequest: FamilyGroupRequest = {
      ...baseRequest,
      id: "request-4",
      type: "GROUP_CREATE",
      familyGroup: { id: "group-new", name: "New Family", members: [] },
      invitedMember: {
        id: "partner-1",
        firstName: "Pat",
        lastName: "Partner",
        email: "pat@example.com",
      },
      matchingMembers: [],
    };

    expect(getFamilyGroupRequestTypeLabel(groupCreateRequest)).toBe(
      "New Family Group"
    );
    expect(getFamilyGroupRequestSummary(groupCreateRequest)).toBe(
      "Ada Parent wants to create the new family group New Family and invite Pat Partner."
    );
    expect(
      getFamilyGroupRequestSummary({ ...groupCreateRequest, invitedMember: null })
    ).toBe("Ada Parent wants to create the new family group New Family.");
    // GROUP_CREATE never seeds a member-record selection.
    expect(buildInitialRequestSelections([groupCreateRequest], {})).toEqual({});
  });
});
