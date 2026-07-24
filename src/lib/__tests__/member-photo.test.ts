import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { deleteOwnedMemberPhotoBlobs } from "@/lib/member-photo";

type HelperTx = Parameters<typeof deleteOwnedMemberPhotoBlobs>[0];

function txWithDeleteMany(count = 2) {
  const deleteMany = vi.fn().mockResolvedValue({ count });
  const tx = { mediaImage: { deleteMany } } as unknown as HelperTx;
  return { tx, deleteMany };
}

describe("deleteOwnedMemberPhotoBlobs", () => {
  it("merge shape: sweeps own photo + uploads, spares other members' blobs and the kept photo", async () => {
    const { tx, deleteMany } = txWithDeleteMany(2);

    const result = await deleteOwnedMemberPhotoBlobs(tx, {
      memberId: "loser-1",
      photoImageId: "loser-img",
      keepImageId: "master-img",
    });

    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        kind: "MEMBER_PHOTO",
        OR: [{ uploadedByMemberId: "loser-1" }, { id: "loser-img" }],
        photoOfMembers: { none: { id: { not: "loser-1" } } },
        NOT: { id: "master-img" },
      },
    });
    expect(result).toEqual({ deleted: 2 });
  });

  it("deletion shape: no keep, still spares blobs referenced by another surviving member", async () => {
    const { tx, deleteMany } = txWithDeleteMany();

    await deleteOwnedMemberPhotoBlobs(tx, {
      memberId: "gone-1",
      photoImageId: "gone-img",
    });

    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        kind: "MEMBER_PHOTO",
        OR: [{ uploadedByMemberId: "gone-1" }, { id: "gone-img" }],
        photoOfMembers: { none: { id: { not: "gone-1" } } },
      },
    });
  });

  it("omits the id clause when the member has no current photo pointer", async () => {
    const { tx, deleteMany } = txWithDeleteMany();

    await deleteOwnedMemberPhotoBlobs(tx, {
      memberId: "m-1",
      photoImageId: null,
    });

    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        kind: "MEMBER_PHOTO",
        OR: [{ uploadedByMemberId: "m-1" }],
        photoOfMembers: { none: { id: { not: "m-1" } } },
      },
    });
  });
});
