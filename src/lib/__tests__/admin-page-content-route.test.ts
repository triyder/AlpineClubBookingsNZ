import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  pageContentFindUnique: vi.fn(),
  pageContentFindFirst: vi.fn(),
  pageContentFindMany: vi.fn(),
  pageContentCreate: vi.fn(),
  pageContentUpdate: vi.fn(),
  auditLogCreate: vi.fn(),
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditRequestContext: vi.fn(() => ({
    id: "req-1",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  })),
  revalidatePublicPageContent: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: mocks.buildStructuredAuditLogCreateArgs,
  getAuditRequestContext: mocks.getAuditRequestContext,
}));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: mocks.revalidatePublicPageContent,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    pageContent: {
      findUnique: mocks.pageContentFindUnique,
      findFirst: mocks.pageContentFindFirst,
      findMany: mocks.pageContentFindMany,
      create: mocks.pageContentCreate,
      update: mocks.pageContentUpdate,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
  },
}));

import { PATCH, POST, PUT } from "@/app/api/admin/page-content/route";

function jsonRequest(method: "POST" | "PUT" | "PATCH", body: unknown) {
  return new NextRequest("http://localhost/api/admin/page-content", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const adminSession = { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } };

const baseCreateBody = {
  caption: "Trips",
  menuTitle: "Trips",
  title: "Trip Reports",
  headerText: "<p>Latest trips</p>",
  slug: "trip-reports",
  sortOrder: 40,
};

describe("POST /api/admin/page-content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.pageContentFindFirst.mockResolvedValue(null);
    mocks.pageContentCreate.mockImplementation(async ({ data }) => ({
      id: "page-1",
      ...data,
      updatedAt: new Date("2026-06-11T00:00:00Z"),
    }));
    mocks.auditLogCreate.mockResolvedValue({});
  });

  it("requires an admin session", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await POST(jsonRequest("POST", baseCreateBody));
    expect(response.status).toBe(401);
    expect(mocks.pageContentCreate).not.toHaveBeenCalled();
  });

  it("sanitises headerText before storing it", async () => {
    const response = await POST(
      jsonRequest("POST", {
        ...baseCreateBody,
        headerText: '<p>ok</p><script>alert("x")</script>',
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.pageContentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ headerText: "<p>ok</p>" }),
      }),
    );
    expect(mocks.revalidatePublicPageContent).toHaveBeenCalledOnce();
  });

  it("rejects slugs containing reserved segments", async () => {
    const response = await POST(
      jsonRequest("POST", { ...baseCreateBody, slug: "admin/settings" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.pageContentCreate).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });

  it("rejects duplicate slugs", async () => {
    mocks.pageContentFindFirst.mockResolvedValue({ id: "existing" });
    const response = await POST(jsonRequest("POST", baseCreateBody));
    expect(response.status).toBe(409);
  });
});

describe("PUT /api/admin/page-content", () => {
  const baseUpdateBody = {
    id: "page-1",
    ...baseCreateBody,
    contentHtml: "<p>Body</p>",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.pageContentFindUnique.mockResolvedValue({
      id: "page-1",
      contentHtml: "<p>Old</p>",
    });
    mocks.pageContentFindFirst.mockResolvedValue(null);
    mocks.pageContentUpdate.mockImplementation(async ({ data }) => ({
      id: "page-1",
      ...data,
      updatedAt: new Date("2026-06-11T00:00:00Z"),
    }));
    mocks.auditLogCreate.mockResolvedValue({});
  });

  it("sanitises contentHtml and headerText before storing them", async () => {
    const response = await PUT(
      jsonRequest("PUT", {
        ...baseUpdateBody,
        headerText: '<p onclick="x()">intro</p>',
        contentHtml: '<p>ok</p><style>body{display:none}</style>',
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.pageContentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          headerText: "<p>intro</p>",
          contentHtml: "<p>ok</p>",
        }),
      }),
    );
    expect(mocks.revalidatePublicPageContent).toHaveBeenCalledOnce();
  });

  it("rejects slugs containing reserved segments", async () => {
    const response = await PUT(
      jsonRequest("PUT", { ...baseUpdateBody, slug: "api/pages" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.pageContentUpdate).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/page-content (publish toggle)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.pageContentUpdate.mockImplementation(async ({ data }) => ({
      id: "page-1",
      slug: "trip-reports",
      path: "/trip-reports",
      ...data,
      updatedAt: new Date("2026-06-28T00:00:00Z"),
    }));
    mocks.auditLogCreate.mockResolvedValue({});
  });

  it("requires an admin session", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await PATCH(
      jsonRequest("PATCH", { id: "page-1", published: false }),
    );
    expect(response.status).toBe(401);
    expect(mocks.pageContentUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 when the page does not exist", async () => {
    mocks.pageContentFindUnique.mockResolvedValue(null);
    const response = await PATCH(
      jsonRequest("PATCH", { id: "missing", published: false }),
    );
    expect(response.status).toBe(404);
    expect(mocks.pageContentUpdate).not.toHaveBeenCalled();
  });

  it("hides an admin-created page and audits the change", async () => {
    mocks.pageContentFindUnique.mockResolvedValue({
      id: "page-1",
      slug: "trip-reports",
      path: "/trip-reports",
      published: true,
    });

    const response = await PATCH(
      jsonRequest("PATCH", { id: "page-1", published: false }),
    );

    expect(response.status).toBe(200);
    expect(mocks.pageContentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ published: false }),
      }),
    );
    expect(mocks.buildStructuredAuditLogCreateArgs).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PAGE_CONTENT_VISIBILITY_CHANGED",
        metadata: expect.objectContaining({
          slug: "trip-reports",
          published: false,
        }),
      }),
    );
    expect(mocks.revalidatePublicPageContent).toHaveBeenCalledOnce();
  });

  it("blocks hiding a system page", async () => {
    mocks.pageContentFindUnique.mockResolvedValue({
      id: "home-id",
      slug: "home",
      path: "/home",
      published: true,
    });

    const response = await PATCH(
      jsonRequest("PATCH", { id: "home-id", published: false }),
    );

    expect(response.status).toBe(422);
    expect(mocks.pageContentUpdate).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });

  it("blocks hiding a built-in design page", async () => {
    mocks.pageContentFindUnique.mockResolvedValue({
      id: "about-id",
      slug: "about",
      path: "/about",
      published: true,
    });

    const response = await PATCH(
      jsonRequest("PATCH", { id: "about-id", published: false }),
    );

    expect(response.status).toBe(422);
    expect(mocks.pageContentUpdate).not.toHaveBeenCalled();
  });

  it("re-publishes a built-in page without the guard blocking it", async () => {
    mocks.pageContentFindUnique.mockResolvedValue({
      id: "about-id",
      slug: "about",
      path: "/about",
      published: false,
    });

    const response = await PATCH(
      jsonRequest("PATCH", { id: "about-id", published: true }),
    );

    expect(response.status).toBe(200);
    expect(mocks.pageContentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ published: true }),
      }),
    );
  });
});
