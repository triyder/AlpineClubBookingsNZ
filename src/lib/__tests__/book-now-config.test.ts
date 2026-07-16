import { beforeEach, describe, expect, it, vi } from "vitest";

// Neutralise the client-boundary guard so the server-only module imports in node.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/prisma", () => ({
  prisma: { publicContentSettings: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/auth-redirect", () => ({
  buildBookingLoginPath: () => "/login?next=/book",
}));

import { prisma } from "@/lib/prisma";
import { getBookNowConfig } from "@/lib/book-now-config";

const findUnique = (
  prisma.publicContentSettings as unknown as { findUnique: ReturnType<typeof vi.fn> }
).findUnique;

describe("getBookNowConfig fail-open matrix (E3 #1929)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("defaults to the booking flow when no settings row exists", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getBookNowConfig(true)).toEqual({ show: true, href: "/book" });
    expect(await getBookNowConfig(false)).toEqual({
      show: true,
      href: "/login?next=/book",
    });
  });

  it("hides the button when showBookNow is false", async () => {
    findUnique.mockResolvedValue({ showBookNow: false, bookNowTarget: "BOOKING_FLOW", bookNowPage: null });
    expect(await getBookNowConfig(true)).toEqual({ show: false, href: "/book" });
  });

  it("targets a published page's path", async () => {
    findUnique.mockResolvedValue({
      showBookNow: true,
      bookNowTarget: "PAGE",
      bookNowPage: { path: "/how-to-book", published: true },
    });
    expect(await getBookNowConfig(true)).toEqual({ show: true, href: "/how-to-book" });
  });

  it("fails open when the PAGE target is unpublished", async () => {
    findUnique.mockResolvedValue({
      showBookNow: true,
      bookNowTarget: "PAGE",
      bookNowPage: { path: "/how-to-book", published: false },
    });
    expect(await getBookNowConfig(true)).toEqual({ show: true, href: "/book" });
  });

  it("fails open when the PAGE target FK is null", async () => {
    findUnique.mockResolvedValue({ showBookNow: true, bookNowTarget: "PAGE", bookNowPage: null });
    expect(await getBookNowConfig(false)).toEqual({ show: true, href: "/login?next=/book" });
  });

  it("fails open when the DB read throws", async () => {
    findUnique.mockRejectedValue(new Error("db down"));
    expect(await getBookNowConfig(true)).toEqual({ show: true, href: "/book" });
  });
});
