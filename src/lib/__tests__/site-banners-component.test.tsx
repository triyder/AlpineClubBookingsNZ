// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SiteBanners, type SiteBannerItem } from "@/components/site-banners";

const DISMISSED_STORAGE_KEY = "site-banners.dismissed.v1";

function banner(overrides: Partial<SiteBannerItem> = {}): SiteBannerItem {
  return {
    id: "banner-1",
    message: "Mountain closed due to volcanic activity",
    priority: "URGENT",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("SiteBanners", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders nothing for an empty banner list", () => {
    const { container } = render(<SiteBanners banners={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders an URGENT banner as an alert with the faded red palette", () => {
    render(<SiteBanners banners={[banner()]} />);

    const bar = screen.getByRole("alert");
    expect(bar.className).toContain("bg-red-100");
    expect(bar.className).toContain("border-red-300");
    expect(bar.className).toContain("text-red-900");
    expect(
      screen.getByText("Mountain closed due to volcanic activity"),
    ).toBeDefined();
  });

  it("renders WARNING and NOTIFY banners as status bars with their palettes", () => {
    render(
      <SiteBanners
        banners={[
          banner({ id: "warning-1", priority: "WARNING", message: "Road icy" }),
          banner({ id: "notify-1", priority: "NOTIFY", message: "AGM soon" }),
        ]}
      />,
    );

    const bars = screen.getAllByRole("status");
    expect(bars).toHaveLength(2);
    expect(bars[0].className).toContain("bg-amber-100");
    expect(bars[1].className).toContain("bg-blue-100");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("dismisses a banner and records the dismissal in localStorage", async () => {
    render(<SiteBanners banners={[banner()]} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));

    await waitFor(() => {
      expect(
        screen.queryByText("Mountain closed due to volcanic activity"),
      ).toBeNull();
    });

    const stored = JSON.parse(
      window.localStorage.getItem(DISMISSED_STORAGE_KEY) ?? "{}",
    ) as Record<string, string>;
    expect(typeof stored["banner-1"]).toBe("string");
    expect(Number.isNaN(Date.parse(stored["banner-1"]))).toBe(false);
  });

  it("keeps a previously dismissed banner hidden", async () => {
    window.localStorage.setItem(
      DISMISSED_STORAGE_KEY,
      JSON.stringify({ "banner-1": "2026-07-01T12:00:00.000Z" }),
    );

    render(
      <SiteBanners
        banners={[banner({ updatedAt: "2026-07-01T00:00:00.000Z" })]}
      />,
    );

    await waitFor(() => {
      expect(
        screen.queryByText("Mountain closed due to volcanic activity"),
      ).toBeNull();
    });
  });

  it("re-shows a dismissed banner after it is edited (updatedAt newer)", async () => {
    window.localStorage.setItem(
      DISMISSED_STORAGE_KEY,
      JSON.stringify({ "banner-1": "2026-07-01T12:00:00.000Z" }),
    );

    render(
      <SiteBanners
        banners={[banner({ updatedAt: "2026-07-02T00:00:00.000Z" })]}
      />,
    );

    // The mount effect runs, but the newer updatedAt invalidates the
    // stored dismissal so the banner stays visible.
    await waitFor(() => {
      expect(
        screen.getByText("Mountain closed due to volcanic activity"),
      ).toBeDefined();
    });
  });

  it("only hides the dismissed banner, leaving others visible", async () => {
    render(
      <SiteBanners
        banners={[
          banner(),
          banner({ id: "notify-1", priority: "NOTIFY", message: "AGM soon" }),
        ]}
      />,
    );

    const [firstDismiss] = screen.getAllByRole("button", {
      name: "Dismiss notice",
    });
    fireEvent.click(firstDismiss);

    await waitFor(() => {
      expect(
        screen.queryByText("Mountain closed due to volcanic activity"),
      ).toBeNull();
    });
    expect(screen.getByText("AGM soon")).toBeDefined();
  });
});
