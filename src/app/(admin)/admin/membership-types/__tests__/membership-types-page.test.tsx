// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminMembershipTypesPage from "@/app/(admin)/admin/membership-types/page";

const fetchMock = vi.fn();

const membershipTypes = [
  {
    id: "type-full",
    key: "FULL",
    name: "Full",
    description: "Default full club membership.",
    isActive: true,
    isBuiltIn: true,
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    sortOrder: 0,
    assignmentCount: 12,
    allowedAgeTiers: ["INFANT", "CHILD", "YOUTH", "ADULT"],
    xeroContactGroupRules: [],
  },
  {
    id: "type-associate",
    key: "ASSOCIATE",
    name: "Associate",
    description: "Associate membership.",
    isActive: true,
    isBuiltIn: true,
    bookingBehavior: "NON_MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    sortOrder: 1,
    assignmentCount: 3,
    allowedAgeTiers: ["ADULT"],
    xeroContactGroupRules: [
      {
        id: "rule-associate",
        ageTier: "ADULT",
        mode: "ACCEPTED",
        groupId: "group-associate",
        groupName: "Associate members",
        isActive: true,
        sortOrder: 0,
      },
    ],
  },
];

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  };
}

function mockFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.startsWith("/api/admin/xero/contact-groups")) {
      return jsonResponse({
        groups: [
          {
            id: "group-associate",
            name: "Associate members",
            contactCount: 3,
          },
          {
            id: "group-life",
            name: "Life members",
            contactCount: 4,
          },
        ],
      });
    }

    if (url === "/api/admin/membership-types/reorder") {
      const payload = JSON.parse(String(init?.body));
      const reordered = payload.orderedIds.map((id: string, index: number) => ({
        ...membershipTypes.find((type) => type.id === id),
        sortOrder: index,
      }));
      return jsonResponse({ membershipTypes: reordered });
    }

    if (url === "/api/admin/membership-types/type-full") {
      return jsonResponse({
        membershipType: {
          ...membershipTypes[0],
          description: "Updated description",
        },
      });
    }

    if (url === "/api/admin/membership-types") {
      return jsonResponse({ membershipTypes });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });
}

async function renderPage() {
  render(<AdminMembershipTypesPage />);
  await waitFor(() => expect(screen.queryByText("Full")).not.toBeNull());
}

describe("AdminMembershipTypesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
    mockFetch();
  });

  it("renders a scannable list and posts the new order when a type is moved", async () => {
    await renderPage();

    expect(screen.queryByText("Default full club membership.")).not.toBeNull();
    expect(screen.queryByText("Member rate")).not.toBeNull();
    expect(screen.queryByText("12 assignments")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Move Associate up" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/membership-types/reorder",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            orderedIds: ["type-associate", "type-full"],
          }),
        }),
      ),
    );
  });

  it("keeps editor dirty state when the dialog is closed and reopened", async () => {
    await renderPage();

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(
      screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Updated description" },
    });
    expect(screen.getByText("Unsaved changes")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled"),
    ).toBe(false);

    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);

    expect(screen.getByLabelText("Description")).toHaveProperty(
      "value",
      "Updated description",
    );
    expect(screen.getByText("Unsaved changes")).not.toBeNull();
  });

  it("keeps editor dirty state after another type is reordered", async () => {
    await renderPage();

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Updated description" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);

    fireEvent.click(screen.getByRole("button", { name: "Move Associate up" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/membership-types/reorder",
        expect.objectContaining({ method: "POST" }),
      ),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);

    expect(screen.getByLabelText("Description")).toHaveProperty(
      "value",
      "Updated description",
    );
    expect(screen.getByText("Unsaved changes")).not.toBeNull();
  });

  it(
    "validates required tiers and required Xero rule groups in the editor",
    async () => {
      await renderPage();

      fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
      for (const label of ["Infant", "Child", "Youth", "Adult"]) {
        fireEvent.click(screen.getByLabelText(label));
      }

      expect(screen.getByRole("alert").textContent).toContain(
        "Select at least one allowed age tier.",
      );
      expect(
        screen
          .getByRole("button", { name: "Save changes" })
          .hasAttribute("disabled"),
      ).toBe(true);

      fireEvent.click(screen.getByLabelText("Adult"));
      fireEvent.click(screen.getByRole("button", { name: "Add Xero rule" }));

      expect(screen.getByRole("alert").textContent).toContain(
        "Every Xero group rule needs a group.",
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Remove Xero group rule" }),
      );
      expect(
        screen.queryByText("Every Xero group rule needs a group."),
      ).toBeNull();
    },
    10000,
  );
});
