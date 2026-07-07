// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";

describe("view-only admin action controls", () => {
  it("disables write actions and exposes the read-only reason to AT", () => {
    render(
      <ViewOnlyActionButton canEdit={false}>Approve</ViewOnlyActionButton>,
    );

    const button = screen.getByRole("button", { name: /Approve/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", ADMIN_VIEW_ONLY_ACTION_REASON);

    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")).toHaveTextContent(
      ADMIN_VIEW_ONLY_ACTION_REASON,
    );
  });
});
