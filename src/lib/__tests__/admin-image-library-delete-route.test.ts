import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  mediaImageFindFirst: vi.fn(),
  mediaImageDeleteMany: vi.fn(),
  pageContentFindMany: vi.fn(),
  auditLogCreate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    mediaImage: {
      findFirst: mocks.mediaImageFindFirst,
      deleteMany: mocks.mediaImageDeleteMany,
    },
    pageContent: {
      findMany: mocks.pageContentFindMany,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
  },
}));

import { DELETE } from "@/app/api/admin/image-library/[id]/route";

const adminSession = { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } };
const memberSession = { user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } };

function deleteRequest(id: string) {
  return new NextRequest(`http://localhost/api/admin/image-library/${id}`, {
    method: "DELETE",
  });
}

describe("DELETE /api/admin/image-library/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.pageContentFindMany.mockResolvedValue([]);
    mocks.mediaImageDeleteMany.mockResolvedValue({ count: 1 });
    mocks.auditLogCreate.mockResolvedValue({});
  });

  it("requires an admin session", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await DELETE(deleteRequest("img-1"), {
      params: Promise.resolve({ id: "img-1" }),
    });
    expect(response.status).toBe(401);
    expect(mocks.mediaImageDeleteMany).not.toHaveBeenCalled();
  });

  it("rejects non-admin members", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const response = await DELETE(deleteRequest("img-1"), {
      params: Promise.resolve({ id: "img-1" }),
    });
    expect(response.status).toBe(403);
    expect(mocks.mediaImageDeleteMany).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown image", async () => {
    mocks.mediaImageFindFirst.mockResolvedValue(null);

    const response = await DELETE(deleteRequest("missing"), {
      params: Promise.resolve({ id: "missing" }),
    });

    expect(response.status).toBe(404);
    expect(mocks.mediaImageDeleteMany).not.toHaveBeenCalled();
  });

  it("scopes the lookup to CONTENT so a MEMBER_PHOTO id cannot be deleted", async () => {
    // A member-photo blob shares the MediaImage table; the scoped lookup finds
    // nothing, so a content admin who knows its id gets the not-found response
    // and no delete is issued.
    mocks.mediaImageFindFirst.mockResolvedValue(null);

    const response = await DELETE(deleteRequest("member-photo-1"), {
      params: Promise.resolve({ id: "member-photo-1" }),
    });

    expect(response.status).toBe(404);
    expect(mocks.mediaImageFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "member-photo-1", kind: "CONTENT" },
      }),
    );
    expect(mocks.mediaImageDeleteMany).not.toHaveBeenCalled();
  });

  it("deletes a CONTENT image that is not referenced by any page", async () => {
    mocks.mediaImageFindFirst.mockResolvedValue({
      id: "img-1",
      filename: "photo.png",
    });
    mocks.pageContentFindMany.mockResolvedValue([]);

    const response = await DELETE(deleteRequest("img-1"), {
      params: Promise.resolve({ id: "img-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, referencedBySlugs: [] });
    // The delete itself is kind-scoped (defence in depth).
    expect(mocks.mediaImageDeleteMany).toHaveBeenCalledWith({
      where: { id: "img-1", kind: "CONTENT" },
    });
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });

  it("permits deletion of a referenced image and reports which pages use it", async () => {
    mocks.mediaImageFindFirst.mockResolvedValue({
      id: "img-1",
      filename: "hero.jpg",
    });
    mocks.pageContentFindMany.mockResolvedValue([
      { slug: "home" },
      { slug: "about" },
    ]);

    const response = await DELETE(deleteRequest("img-1"), {
      params: Promise.resolve({ id: "img-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      referencedBySlugs: ["home", "about"],
    });
    expect(mocks.mediaImageDeleteMany).toHaveBeenCalledWith({
      where: { id: "img-1", kind: "CONTENT" },
    });

    expect(mocks.pageContentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { contentHtml: { contains: "/api/images/img-1" } },
            { headerText: { contains: "/api/images/img-1" } },
          ],
        },
      }),
    );
  });
});
