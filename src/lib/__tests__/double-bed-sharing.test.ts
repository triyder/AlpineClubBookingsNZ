import { describe, it, expect, vi } from "vitest";
import { mayShareDoubleBed } from "@/lib/double-bed-sharing";

type FakeMember = {
  id: string;
  ageTier: string;
  familyGroupMemberships: Array<{ familyGroupId: string }>;
};

// The predicate takes a db client, so a tiny fake `member.findMany` is all the
// test needs — no prisma mock. findMany filters the seeded members by the
// `where: { id: { in: [...] } }` clause the predicate builds.
function fakeDb(members: FakeMember[]) {
  return {
    member: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
        const ids = args.where.id.in;
        return members.filter((member) => ids.includes(member.id));
      }),
    },
  } as unknown as NonNullable<Parameters<typeof mayShareDoubleBed>[2]>;
}

const adult = (id: string, groups: string[]): FakeMember => ({
  id,
  ageTier: "ADULT",
  familyGroupMemberships: groups.map((familyGroupId) => ({ familyGroupId })),
});

describe("mayShareDoubleBed", () => {
  it("allows two adults in the same family group", async () => {
    const db = fakeDb([adult("a", ["g1"]), adult("b", ["g1", "g2"])]);
    await expect(mayShareDoubleBed("a", "b", db)).resolves.toBe(true);
  });

  it("rejects two adults in different family groups", async () => {
    const db = fakeDb([adult("a", ["g1"]), adult("b", ["g2"])]);
    await expect(mayShareDoubleBed("a", "b", db)).resolves.toBe(false);
  });

  it("rejects when either member is a minor", async () => {
    const db = fakeDb([
      adult("a", ["g1"]),
      { id: "b", ageTier: "YOUTH", familyGroupMemberships: [{ familyGroupId: "g1" }] },
    ]);
    await expect(mayShareDoubleBed("a", "b", db)).resolves.toBe(false);
  });

  it("rejects the same member id (cannot partner with self)", async () => {
    const db = fakeDb([adult("a", ["g1"])]);
    await expect(mayShareDoubleBed("a", "a", db)).resolves.toBe(false);
  });

  it("rejects when a member id does not resolve", async () => {
    const db = fakeDb([adult("a", ["g1"])]);
    await expect(mayShareDoubleBed("a", "ghost", db)).resolves.toBe(false);
  });

  it("rejects when a member has no family group at all", async () => {
    const db = fakeDb([adult("a", ["g1"]), adult("b", [])]);
    await expect(mayShareDoubleBed("a", "b", db)).resolves.toBe(false);
  });

  it("rejects empty member ids without querying", async () => {
    const db = fakeDb([adult("a", ["g1"])]);
    await expect(mayShareDoubleBed("", "b", db)).resolves.toBe(false);
    expect((db.member.findMany as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
