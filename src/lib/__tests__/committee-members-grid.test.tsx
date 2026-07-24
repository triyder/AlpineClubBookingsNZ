// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitteeMembersGrid } from "@/components/website/committee-members-grid";

describe("CommitteeMembersGrid", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        members: [
          {
            id: "assign-hidden-phone",
            role: "President",
            roleKey: "president",
            name: "Alex Admin",
            phone: null,
            contactKey: null,
            description: "Current president.",
          },
          {
            id: "assign-contactable",
            role: "Secretary",
            roleKey: "secretary",
            name: "Jamie Jones",
            phone: "021 555 0100",
            contactKey: "assign-contactable",
            description: null,
          },
        ],
      }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders optional phone and contact links without requiring public email", async () => {
    render(<CommitteeMembersGrid />);

    await waitFor(() => expect(screen.getByText("Alex Admin")).toBeTruthy());

    expect(screen.getByText("Current president.")).toBeTruthy();
    expect(screen.queryByText(/example\.org/i)).toBeNull();
    expect(screen.getByText("021 555 0100")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /021 555 0100/i })
        .getAttribute("href"),
    ).toBe("tel:0215550100");
    expect(
      screen
        .getByRole("link", { name: /send a message/i })
        .getAttribute("href"),
    ).toBe("/contact?recipient=assign-contactable");
  });

  it("renders no avatars when the roster photo display is NONE (default)", async () => {
    render(<CommitteeMembersGrid />);
    await waitFor(() => expect(screen.getByText("Alex Admin")).toBeTruthy());
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("AA")).toBeNull(); // no initials placeholder either
  });

  it("renders photos and an initials fallback in the chosen shape when enabled", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        photoDisplay: "CIRCLE",
        members: [
          {
            id: "a1",
            role: "President",
            roleKey: "president",
            name: "Alex Admin",
            phone: null,
            contactKey: null,
            description: null,
            photo: { memberId: "mem-1", version: "v9" },
          },
          {
            id: "a2",
            role: "Secretary",
            roleKey: "secretary",
            name: "Jamie Jones",
            phone: null,
            contactKey: null,
            description: null,
            photo: null,
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const { container } = render(<CommitteeMembersGrid />);
    await waitFor(() => expect(screen.getByText("Alex Admin")).toBeTruthy());

    // Member with a photo: scoped, cache-busted serving URL, never /api/images.
    const img = screen.getByAltText("Alex Admin's photo") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/members/mem-1/photo?v=v9");
    expect(img.getAttribute("src")).not.toContain("/api/images");
    // Roster photos are lazy-loaded so the public page is not blocked on them.
    expect(img.getAttribute("loading")).toBe("lazy");
    // Member without a photo: initials placeholder.
    expect(screen.getByText("JJ")).toBeTruthy();
    // Circular shape applied to the avatar wrappers.
    expect(container.querySelector(".rounded-full")).toBeTruthy();
    expect(container.querySelector(".rounded-lg")).toBeNull();
  });

  it("falls back to initials when a roster photo fails to load (never a broken image on the public page)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        photoDisplay: "CIRCLE",
        members: [
          {
            id: "a1",
            role: "President",
            roleKey: "president",
            name: "Alex Admin",
            phone: null,
            contactKey: null,
            description: null,
            photo: { memberId: "mem-1", version: "v9" },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    render(<CommitteeMembersGrid />);
    const img = (await waitFor(() =>
      screen.getByAltText("Alex Admin's photo"),
    )) as HTMLImageElement;

    // Simulate the scoped endpoint failing (or the photo removed after fetch).
    fireEvent.error(img);

    await waitFor(() =>
      expect(screen.queryByAltText("Alex Admin's photo")).toBeNull(),
    );
    // The initials placeholder now stands in for the broken image.
    expect(screen.getByText("AA")).toBeTruthy();
  });
});
