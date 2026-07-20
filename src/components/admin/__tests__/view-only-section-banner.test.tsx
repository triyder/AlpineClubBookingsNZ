// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADMIN_VIEW_ONLY_SECTION_HEADING,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";

// #2142 owner decision: the view-only explanation moves from each disabled
// button to ONE section-level banner. The old per-button affordance was
// unreachable exactly where it mattered — a disabled button is out of the tab
// order, so a keyboard or screen-reader user never landed on it and never heard
// the `title` / `aria-describedby` reason.

afterEach(cleanup);

describe("AdminViewOnlySectionBanner (#2142)", () => {
  it("announces the view-only state to assistive tech, in the reading order", () => {
    render(
      <AdminViewOnlySectionBanner canEdit={false}>
        Bookings edit access is required.
      </AdminViewOnlySectionBanner>,
    );

    // `role="status"` is an implicit polite live region, so the banner is
    // announced when it appears — which is always, since `canEdit` resolves
    // from `undefined` after hydration.
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain(ADMIN_VIEW_ONLY_SECTION_HEADING);
    expect(banner.textContent).toContain("Bookings edit access is required.");
    // Not visually hidden: it is met in the normal reading order, ahead of the
    // controls it explains.
    expect(banner.className).not.toContain("sr-only");
  });

  it("renders nothing for an edit-capable admin", () => {
    render(<AdminViewOnlySectionBanner canEdit={true}>Detail</AdminViewOnlySectionBanner>);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders nothing while access is still resolving", () => {
    // Tri-state (#2065): an explicitly-passed `undefined` must not flash the
    // banner at an admin who may well turn out to be edit-capable.
    render(
      <AdminViewOnlySectionBanner canEdit={undefined}>Detail</AdminViewOnlySectionBanner>,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("ViewOnlyActionButton describeReason (#2142)", () => {
  it("annotates the button by default, for every caller outside Booking Policies", () => {
    render(<ViewOnlyActionButton canEdit={false}>Approve</ViewOnlyActionButton>);

    const button = screen.getByRole("button", { name: "Approve" });
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("title")).toBe(ADMIN_VIEW_ONLY_ACTION_REASON);
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(String(describedBy))?.textContent).toBe(
      ADMIN_VIEW_ONLY_ACTION_REASON,
    );
  });

  it("drops the annotation but NOT the gating when the section carries the banner", () => {
    render(
      <ViewOnlyActionButton canEdit={false} describeReason={false}>
        Approve
      </ViewOnlyActionButton>,
    );

    const button = screen.getByRole("button", { name: "Approve" });
    // Gating is unchanged — this prop only moves the explanation.
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("title")).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBeNull();
    expect(
      document.querySelector(`.sr-only`)?.textContent ?? "",
    ).not.toContain(ADMIN_VIEW_ONLY_ACTION_REASON);
  });

  it("leaves a caller's own title and aria-describedby intact when opted out", () => {
    render(
      <>
        <span id="own-hint">Own hint</span>
        <ViewOnlyActionButton
          canEdit={false}
          describeReason={false}
          title="Own title"
          aria-describedby="own-hint"
        >
          Approve
        </ViewOnlyActionButton>
      </>,
    );

    const button = screen.getByRole("button", { name: "Approve" });
    expect(button.getAttribute("title")).toBe("Own title");
    expect(button.getAttribute("aria-describedby")).toBe("own-hint");
  });
});
