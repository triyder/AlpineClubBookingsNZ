import { describe, expect, it } from "vitest";
import {
  MEMBER_MERGE_RELATION_SPECS,
  MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS,
  maxFamilyRole,
  memberMergeConfirmationPhrase,
  mergeMemberFields,
  normalizeConfirmationText,
  partitionKeyedCollisions,
  planPartnerLinkMerge,
  type PartnerLinkRow,
} from "@/lib/member-merge";

function baseMember(overrides: Record<string, unknown> = {}) {
  return {
    id: "m",
    email: "a@b.com",
    firstName: "First",
    lastName: "Last",
    title: null,
    gender: null,
    dateOfBirth: null,
    occupation: null,
    phoneCountryCode: null,
    phoneAreaCode: null,
    phoneNumber: null,
    streetAddressLine1: null,
    streetAddressLine2: null,
    streetCity: null,
    streetRegion: null,
    streetPostalCode: null,
    streetCountry: null,
    postalAddressLine1: null,
    postalAddressLine2: null,
    postalCity: null,
    postalRegion: null,
    postalPostalCode: null,
    postalCountry: null,
    lifeMemberDate: null,
    comments: null,
    familyGroupId: null,
    requiresInduction: false,
    hutLeaderEligible: false,
    hutLeaderEligibleAt: null,
    joinedDate: null,
    ...overrides,
  };
}

describe("mergeMemberFields", () => {
  it("fills a blank master field from the loser", () => {
    const { patch, diff } = mergeMemberFields(
      baseMember({ occupation: null }),
      baseMember({ occupation: "Engineer" }),
    );
    expect(patch.occupation).toBe("Engineer");
    expect(diff.find((r) => r.field === "occupation")?.source).toBe("loser");
  });

  it("never fills postLoginLanding from the loser (#2090 — dropped on merge)", () => {
    const { patch, diff } = mergeMemberFields(
      baseMember({ postLoginLanding: null }),
      baseMember({ postLoginLanding: "ADMIN_DASHBOARD" }),
    );
    // A per-account UI preference is not shared personal data: the master keeps
    // its own (null = role default) and the loser's is dropped, not filled in.
    expect(patch.postLoginLanding).toBeUndefined();
    expect(diff.find((r) => r.field === "postLoginLanding")).toBeUndefined();
  });

  it("keeps a populated master field (master wins)", () => {
    const { patch, diff } = mergeMemberFields(
      baseMember({ occupation: "Doctor" }),
      baseMember({ occupation: "Engineer" }),
    );
    expect(patch.occupation).toBeUndefined();
    expect(diff.find((r) => r.field === "occupation")?.result).toBe("Doctor");
  });

  it("treats whitespace-only master strings as blank", () => {
    const { patch } = mergeMemberFields(
      baseMember({ comments: "   " }),
      baseMember({ comments: "real note" }),
    );
    expect(patch.comments).toBe("real note");
  });

  it("fills the whole phone group from the loser only when master's number is blank", () => {
    const { patch } = mergeMemberFields(
      baseMember({ phoneNumber: null }),
      baseMember({ phoneCountryCode: "64", phoneAreaCode: "27", phoneNumber: "123" }),
    );
    expect(patch.phoneCountryCode).toBe("64");
    expect(patch.phoneAreaCode).toBe("27");
    expect(patch.phoneNumber).toBe("123");
  });

  it("never Frankensteins the phone group when master already has a number", () => {
    const { patch } = mergeMemberFields(
      baseMember({ phoneCountryCode: "64", phoneNumber: "999" }),
      baseMember({ phoneCountryCode: "1", phoneAreaCode: "555", phoneNumber: "123" }),
    );
    expect(patch.phoneCountryCode).toBeUndefined();
    expect(patch.phoneAreaCode).toBeUndefined();
    expect(patch.phoneNumber).toBeUndefined();
  });

  it("ORs requiresInduction and hutLeaderEligible", () => {
    const { patch } = mergeMemberFields(
      baseMember({ requiresInduction: false, hutLeaderEligible: false }),
      baseMember({ requiresInduction: true, hutLeaderEligible: true }),
    );
    expect(patch.requiresInduction).toBe(true);
    expect(patch.hutLeaderEligible).toBe(true);
  });

  it("sets hutLeaderEligibleAt to the earliest when either is eligible", () => {
    const early = new Date("2020-01-01");
    const late = new Date("2023-01-01");
    const { patch } = mergeMemberFields(
      baseMember({ hutLeaderEligible: false, hutLeaderEligibleAt: late }),
      baseMember({ hutLeaderEligible: true, hutLeaderEligibleAt: early }),
    );
    expect((patch.hutLeaderEligibleAt as Date).getTime()).toBe(early.getTime());
  });

  it("takes the earliest joinedDate", () => {
    const early = new Date("2015-06-01");
    const late = new Date("2019-06-01");
    const { patch } = mergeMemberFields(
      baseMember({ joinedDate: late }),
      baseMember({ joinedDate: early }),
    );
    expect((patch.joinedDate as Date).getTime()).toBe(early.getTime());
  });

  it("keeps master's joinedDate when it is already the earliest", () => {
    const early = new Date("2015-06-01");
    const late = new Date("2019-06-01");
    const { patch } = mergeMemberFields(
      baseMember({ joinedDate: early }),
      baseMember({ joinedDate: late }),
    );
    expect(patch.joinedDate).toBeUndefined();
  });

  it("never merges auth/identity fields (email, passwordHash, 2FA, xeroContactId, role)", () => {
    const { patch } = mergeMemberFields(
      baseMember({ email: "master@x.com" }),
      baseMember({
        email: "loser@x.com",
        passwordHash: "loserhash",
        xeroContactId: "xero-loser",
        role: "ADMIN",
        canLogin: true,
        emailVerified: true,
        twoFactorEnabled: true,
        totpSecret: "secret",
      }),
    );
    for (const forbidden of [
      "email",
      "passwordHash",
      "xeroContactId",
      "role",
      "canLogin",
      "emailVerified",
      "twoFactorEnabled",
      "totpSecret",
    ]) {
      expect(patch[forbidden]).toBeUndefined();
    }
  });
});

describe("planPartnerLinkMerge", () => {
  const M = "master";
  const L = "loser";

  function link(id: string, a: string, b: string, status = "PENDING"): PartnerLinkRow {
    const [memberAId, memberBId] = a < b ? [a, b] : [b, a];
    return { id, memberAId, memberBId, status };
  }

  it("deletes a loser<->master self-pair", () => {
    const plan = planPartnerLinkMerge([link("1", L, M)], [], M, L);
    expect(plan.deleteIds).toEqual(["1"]);
    expect(plan.updates).toEqual([]);
  });

  it("re-points a loser link to another member with canonical A<B ordering", () => {
    const other = "aaa"; // sorts before master
    const plan = planPartnerLinkMerge([link("1", L, other)], [], M, L);
    expect(plan.updates).toHaveLength(1);
    const u = plan.updates[0];
    expect([u.memberAId, u.memberBId].sort()).toEqual([other, M].sort());
    expect(u.memberAId < u.memberBId).toBe(true);
  });

  it("drops a loser duplicate when master already links the same partner", () => {
    const other = "zzz";
    const plan = planPartnerLinkMerge(
      [link("L1", L, other)],
      [link("M1", M, other)],
      M,
      L,
    );
    expect(plan.deleteIds).toEqual(["L1"]);
    expect(plan.updates).toEqual([]);
  });

  it("keeps master's confirmed partner and drops loser's confirmed link (with warning)", () => {
    const plan = planPartnerLinkMerge(
      [link("L1", L, "other1", "CONFIRMED")],
      [link("M1", M, "other2", "CONFIRMED")],
      M,
      L,
    );
    expect(plan.deleteIds).toEqual(["L1"]);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it("promotes loser's confirmed link when master has no confirmed partner", () => {
    const plan = planPartnerLinkMerge(
      [link("L1", L, "other1", "CONFIRMED")],
      [],
      M,
      L,
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.deleteIds).toEqual([]);
  });

  it("a CONFIRMED master<->loser link (deleted as self-pair) does not block re-pointing loser's genuine CONFIRMED link to a third member", () => {
    const selfPair = link("ML", M, L, "CONFIRMED");
    const toThird = link("LC", L, "third", "CONFIRMED");
    const plan = planPartnerLinkMerge([selfPair, toThird], [selfPair], M, L);
    // The master<->loser pair is deleted, NOT treated as master's confirmed
    // partner, so the loser's confirmed link to `third` is re-pointed.
    expect(plan.deleteIds).toEqual(["ML"]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].id).toBe("LC");
    expect([plan.updates[0].memberAId, plan.updates[0].memberBId].sort()).toEqual(
      [M, "third"].sort(),
    );
  });
});

describe("partitionKeyedCollisions (collision matrix)", () => {
  it("single-key: drops loser rows colliding on the key, moves the rest", () => {
    // CommitteeAssignment-style: key = committeeRoleId (member column excluded).
    const loser = [
      { id: "L1", committeeRoleId: "r1" }, // both-have -> drop
      { id: "L2", committeeRoleId: "r2" }, // loser-only -> move
    ];
    const master = [{ id: "M1", committeeRoleId: "r1" }];
    const { dropIds, moveIds } = partitionKeyedCollisions(loser, master, [["committeeRoleId"]]);
    expect(dropIds).toEqual(["L1"]);
    expect(moveIds).toEqual(["L2"]);
  });

  it("neither-have: everything moves when master has no rows", () => {
    const loser = [{ id: "L1", seasonYear: 2025 }];
    const { dropIds, moveIds } = partitionKeyedCollisions(loser, [], [["seasonYear"]]);
    expect(dropIds).toEqual([]);
    expect(moveIds).toEqual(["L1"]);
  });

  it("multi-unique: a collision on EITHER unique drops the loser row", () => {
    // PromoRedemptionAllocation-style: two uniques.
    const loser = [
      { id: "L1", promoRedemptionId: "pr1", promoCodeId: "pc9", bookingId: "b9" }, // collides on unique #1
      { id: "L2", promoRedemptionId: "prX", promoCodeId: "pc1", bookingId: "b1" }, // collides on unique #2
      { id: "L3", promoRedemptionId: "prZ", promoCodeId: "pcZ", bookingId: "bZ" }, // no collision -> move
    ];
    const master = [
      { id: "M1", promoRedemptionId: "pr1", promoCodeId: "pcM", bookingId: "bM" },
      { id: "M2", promoRedemptionId: "prM", promoCodeId: "pc1", bookingId: "b1" },
    ];
    const { dropIds, moveIds } = partitionKeyedCollisions(loser, master, [
      ["promoRedemptionId"],
      ["promoCodeId", "bookingId"],
    ]);
    expect(new Set(dropIds)).toEqual(new Set(["L1", "L2"]));
    expect(moveIds).toEqual(["L3"]);
  });

  it("NULL-distinct: two custom access roles (role=null) never collide (MemberAccessRole)", () => {
    // Both rows are custom-role rows with role=null but different roleDefinitionId.
    const loser = [{ id: "L1", role: null, roleDefinitionId: "defX" }];
    const master = [{ id: "M1", role: null, roleDefinitionId: "defY" }];
    const { dropIds, moveIds } = partitionKeyedCollisions(loser, master, [
      ["role"],
      ["roleDefinitionId"],
    ]);
    // role=null must NOT collide; roleDefinitionId differs -> move, not drop.
    expect(dropIds).toEqual([]);
    expect(moveIds).toEqual(["L1"]);
  });

  it("NULL-distinct: same non-null roleDefinitionId still collides", () => {
    const loser = [{ id: "L1", role: null, roleDefinitionId: "defX" }];
    const master = [{ id: "M1", role: null, roleDefinitionId: "defX" }];
    const { dropIds } = partitionKeyedCollisions(loser, master, [
      ["role"],
      ["roleDefinitionId"],
    ]);
    expect(dropIds).toEqual(["L1"]);
  });

  it("1-1 (empty key spec): a single master row collides with the loser's", () => {
    // NotificationPreference-style: unique on memberId alone -> key = [] (constant).
    const { dropIds, moveIds } = partitionKeyedCollisions(
      [{ id: "L1" }],
      [{ id: "M1" }],
      [[]],
    );
    expect(dropIds).toEqual(["L1"]);
    expect(moveIds).toEqual([]);
  });
});

describe("maxFamilyRole", () => {
  it("upgrades to ADMIN when either side is ADMIN", () => {
    expect(maxFamilyRole("MEMBER", "ADMIN")).toBe("ADMIN");
    expect(maxFamilyRole("ADMIN", "MEMBER")).toBe("ADMIN");
    expect(maxFamilyRole("MEMBER", "MEMBER")).toBe("MEMBER");
  });
});

describe("confirmation phrase", () => {
  it("collapses internal whitespace and trims", () => {
    expect(normalizeConfirmationText("  Jane   Doe  ")).toBe("Jane Doe");
  });
  it("builds the MERGE <name> phrase", () => {
    expect(memberMergeConfirmationPhrase("Jane   Doe")).toBe("MERGE Jane Doe");
  });
});

describe("spec bucket integrity", () => {
  it("every spec is exactly one of move/resolve/cascade", () => {
    for (const s of MEMBER_MERGE_RELATION_SPECS) {
      expect(["move", "resolve", "cascade"]).toContain(s.bucket);
    }
  });
  it("only move specs may be self-relations", () => {
    for (const s of MEMBER_MERGE_RELATION_SPECS) {
      if (s.selfRelation) expect(s.bucket).toBe("move");
    }
  });
  it("cascade specs are the auth-identity / token models only", () => {
    const cascadeModels = MEMBER_MERGE_RELATION_SPECS.filter(
      (s) => s.bucket === "cascade",
    ).map((s) => s.model);
    expect(new Set(cascadeModels)).toEqual(
      new Set([
        "PasswordResetToken",
        "MagicLinkToken",
        "EmailVerificationToken",
        "EmailChangeToken",
        "TwoFactorEmailCode",
        "TwoFactorRecoveryCode",
        "TwoFactorSessionChallenge",
        "PartnerInviteToken",
      ]),
    );
  });
  it("documents FK-less snapshot scalar columns", () => {
    expect(MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS).toContain(
      "MemberLifecycleActionRequest.memberId",
    );
    expect(MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS).toContain(
      "BookingModification.memberId",
    );
  });
  it("no documented snapshot scalar column is silently classified in a move/resolve/cascade bucket", () => {
    // The completeness test already guarantees the spec table covers EXACTLY
    // the @relation(fields:) owner keys, so an FK-less scalar is structurally
    // excluded; this asserts the documented list and the spec table never
    // overlap on a Model.column.
    const specColumns = new Set(
      MEMBER_MERGE_RELATION_SPECS.map((s) => `${s.model}.${s.column}`),
    );
    for (const col of MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS) {
      expect(specColumns.has(col), `${col} is classified AND documented as snapshot`).toBe(false);
    }
  });
});
