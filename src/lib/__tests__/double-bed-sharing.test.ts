import { describe, it, expect, vi } from "vitest";
import { mayShareDoubleBed } from "@/lib/double-bed-sharing";
import { canonicalPartnerPair } from "@/lib/member-partner-link-shared";

type FakeMember = {
  id: string;
  ageTier: string;
  active: boolean;
};

type FakePartnerLink = {
  memberAId: string;
  memberBId: string;
  status: string;
};

// The predicate takes a db client, so tiny fakes for `member.findMany` and
// `memberPartnerLink.findUnique` are all the test needs — no prisma mock.
// findMany filters the seeded members by the `where: { id: { in: [...] } }`
// clause the predicate builds; findUnique matches a seeded link by the
// canonical pair the predicate looks up.
function fakeDb(members: FakeMember[], links: FakePartnerLink[] = []) {
  return {
    member: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
        const ids = args.where.id.in;
        return members.filter((member) => ids.includes(member.id));
      }),
    },
    memberPartnerLink: {
      findUnique: vi.fn(
        async (args: {
          where: {
            memberAId_memberBId: { memberAId: string; memberBId: string };
          };
        }) => {
          const pair = args.where.memberAId_memberBId;
          return (
            links.find(
              (link) =>
                link.memberAId === pair.memberAId &&
                link.memberBId === pair.memberBId,
            ) ?? null
          );
        },
      ),
    },
  } as unknown as NonNullable<Parameters<typeof mayShareDoubleBed>[2]>;
}

const adult = (id: string): FakeMember => ({ id, ageTier: "ADULT", active: true });

// Seed a link the way the service stores it: as the canonical ordered pair.
const link = (
  memberOneId: string,
  memberTwoId: string,
  status: string,
): FakePartnerLink => ({
  ...canonicalPartnerPair(memberOneId, memberTwoId),
  status,
});

describe("mayShareDoubleBed", () => {
  it("allows two active adults with a CONFIRMED partner link", async () => {
    const db = fakeDb([adult("a"), adult("b")], [link("a", "b", "CONFIRMED")]);
    await expect(mayShareDoubleBed("a", "b", db)).resolves.toBe(true);
  });

  it("is symmetric: argument order does not matter", async () => {
    const db = fakeDb([adult("a"), adult("b")], [link("a", "b", "CONFIRMED")]);
    await expect(mayShareDoubleBed("b", "a", db)).resolves.toBe(true);
  });

  it("rejects a PENDING (unconfirmed) partner link", async () => {
    const db = fakeDb([adult("a"), adult("b")], [link("a", "b", "PENDING")]);
    await expect(mayShareDoubleBed("a", "b", db)).resolves.toBe(false);
  });

  it("rejects two adults with no partner link (family-group co-membership no longer suffices)", async () => {
    const db = fakeDb([adult("a"), adult("b")]);
    await expect(mayShareDoubleBed("a", "b", db)).resolves.toBe(false);
  });

  it("rejects when either member is a minor, even with a CONFIRMED link", async () => {
    const db = fakeDb(
      [adult("a"), { id: "b", ageTier: "YOUTH", active: true }],
      [link("a", "b", "CONFIRMED")],
    );
    await expect(mayShareDoubleBed("a", "b", db)).resolves.toBe(false);
  });

  it("rejects when either member is inactive, even with a CONFIRMED link", async () => {
    const db = fakeDb(
      [adult("a"), { id: "b", ageTier: "ADULT", active: false }],
      [link("a", "b", "CONFIRMED")],
    );
    await expect(mayShareDoubleBed("a", "b", db)).resolves.toBe(false);
  });

  it("rejects the same member id (cannot partner with self)", async () => {
    const db = fakeDb([adult("a")]);
    await expect(mayShareDoubleBed("a", "a", db)).resolves.toBe(false);
  });

  it("rejects when a member id does not resolve", async () => {
    const db = fakeDb([adult("a")]);
    await expect(mayShareDoubleBed("a", "ghost", db)).resolves.toBe(false);
  });

  it("rejects empty member ids without querying", async () => {
    const db = fakeDb([adult("a")]);
    await expect(mayShareDoubleBed("", "b", db)).resolves.toBe(false);
    expect(db.member.findMany as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});
