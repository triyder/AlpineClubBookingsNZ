import { describe, expect, it } from "vitest";
import {
  getMemberLoginStage,
  getMemberPasswordActionKind,
  LOGIN_STAGE_FILTER_VALUES,
  LOGIN_STAGE_LABELS,
  type MemberLoginStage,
  type MemberPasswordActionKind,
  type MemberPasswordActionState,
} from "@/lib/member-login-stage";

// The four mutually-exclusive login stages (#1444) and how each is produced.
// Stage is type-independent — it depends only on canLogin + setup + pending
// invite — so representative "types" are exercised in the member-table
// component test where the cell renders "{Type} · {Stage}".
const cases: Array<{
  name: string;
  member: MemberPasswordActionState;
  stage: MemberLoginStage;
  kind: MemberPasswordActionKind | null;
}> = [
  {
    name: "no login when canLogin is off",
    member: {
      canLogin: false,
      hasCompletedAccountSetup: false,
      pendingInviteExpiresAt: null,
    },
    stage: "no-login",
    kind: null,
  },
  {
    name: "not invited when login is on but no invite/password yet",
    member: {
      canLogin: true,
      hasCompletedAccountSetup: false,
      pendingInviteExpiresAt: null,
    },
    stage: "not-invited",
    kind: "invite",
  },
  {
    name: "invited when a pending invite is outstanding",
    member: {
      canLogin: true,
      hasCompletedAccountSetup: false,
      pendingInviteExpiresAt: "2999-01-01T00:00:00.000Z",
    },
    stage: "invited",
    kind: "resend-invite",
  },
  {
    name: "can log in once setup is complete",
    member: {
      canLogin: true,
      hasCompletedAccountSetup: true,
      pendingInviteExpiresAt: null,
    },
    stage: "can-login",
    kind: "reset-password",
  },
];

describe("getMemberLoginStage", () => {
  for (const { name, member, stage, kind } of cases) {
    it(`derives ${stage}: ${name}`, () => {
      expect(getMemberLoginStage(member)).toBe(stage);
      // The stage must never disagree with the action-button kind it derives
      // from — the whole point of the shared helper.
      expect(getMemberPasswordActionKind(member)).toBe(kind);
    });
  }

  it("ignores completion state and pending invites once canLogin is off", () => {
    // A record that previously logged in but had login revoked reads as
    // no-login regardless of its residual setup/invite state.
    expect(
      getMemberLoginStage({
        canLogin: false,
        hasCompletedAccountSetup: true,
        pendingInviteExpiresAt: "2999-01-01T00:00:00.000Z",
      }),
    ).toBe("no-login");
  });
});

describe("login-stage lookup tables", () => {
  it("labels every stage", () => {
    expect(LOGIN_STAGE_LABELS).toEqual({
      "no-login": "No login",
      "not-invited": "Not invited",
      invited: "Invited",
      "can-login": "Can log in",
    });
  });

  it("maps every stage to its inviteStatus filter value", () => {
    expect(LOGIN_STAGE_FILTER_VALUES).toEqual({
      "no-login": "no-login",
      "not-invited": "invite",
      invited: "resend-invite",
      "can-login": "reset-password",
    });
  });

  it("keeps the login-on filter values equal to the action kinds", () => {
    // reset-password / resend-invite / invite mirror getMemberPasswordActionKind
    // so the list filter and the row action select the same members.
    for (const { stage, kind } of cases) {
      if (kind === null) continue;
      expect(LOGIN_STAGE_FILTER_VALUES[stage]).toBe(kind);
    }
  });
});
