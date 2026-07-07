// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// The membership-types editor and merge dialogs use the Radix Select, which
// jsdom cannot drive through its pointer-capture flow. Following the repo
// pattern (e.g. access-role-ui.test.tsx), swap it for a native <select> so the
// merge target picker can be exercised deterministically.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    children?: ReactNode;
  }) => (
    <select
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children?: ReactNode;
  }) => <option value={value}>{children}</option>,
}));

import AdminMembershipTypesPage from "@/app/(admin)/admin/membership-types/page";

const fetchMock = vi.fn();

function customType(overrides: Record<string, unknown> = {}) {
  return {
    id: "type-social",
    key: "SOCIAL",
    name: "Social",
    description: "Social membership.",
    isActive: true,
    isBuiltIn: false,
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "NOT_REQUIRED",
    sortOrder: 2,
    assignmentCount: 4,
    allowedAgeTiers: ["ADULT"],
    xeroContactGroupRules: [
      {
        id: "rule-social",
        ageTier: "ADULT",
        mode: "MANAGED",
        groupId: "group-social",
        groupName: "Social members",
        isActive: true,
        sortOrder: 0,
      },
    ],
    ...overrides,
  };
}

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
  customType(),
  customType({
    id: "type-empty",
    key: "EMPTY",
    name: "Empty custom",
    assignmentCount: 0,
    xeroContactGroupRules: [],
  }),
];

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

function mockFetch() {
  fetchMock.mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.startsWith("/api/admin/xero/contact-groups")) {
        return jsonResponse({ groups: [] });
      }

      if (url === "/api/admin/membership-types/type-empty" && method === "DELETE") {
        return jsonResponse({ ok: true });
      }

      if (
        url === "/api/admin/membership-types/type-social/merge" &&
        method === "POST"
      ) {
        return jsonResponse({
          ok: true,
          reassignedCount: 4,
          sourceId: "type-social",
          targetId: "type-associate",
        });
      }

      if (url === "/api/admin/membership-types") {
        return jsonResponse({ membershipTypes });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    },
  );
}

async function renderPage() {
  render(<AdminMembershipTypesPage />);
  await waitFor(() => expect(screen.queryByText("Social")).not.toBeNull());
}

describe("AdminMembershipTypesPage delete + merge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
    mockFetch();
  });

  it("deletes a zero-assignment custom type after confirmation", async () => {
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Delete Empty custom" }));

    expect(screen.getByText("Delete Empty custom?")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete type" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/membership-types/type-empty",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("Deleted Empty custom.")).not.toBeNull(),
    );
  });

  it("opens the merge dialog for a still-assigned custom type, warns on Xero diff, and posts the merge", async () => {
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Delete Social" }));

    // Affected-count summary is shown up front (DialogDescription is one block).
    expect(screen.getByText(/still has 4 seasonal assignments/)).not.toBeNull();

    // Confirm is disabled until a target is chosen.
    const confirmButton = screen.getByRole("button", {
      name: "Merge and delete",
    });
    expect(confirmButton.hasAttribute("disabled")).toBe(true);

    // Pick a target with different Xero rules -> the warning appears.
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "type-associate" },
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "different Xero contact-group rules",
    );
    expect(confirmButton.hasAttribute("disabled")).toBe(false);

    fireEvent.click(confirmButton);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/membership-types/type-social/merge",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ targetId: "type-associate" }),
        }),
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByText(
          "Moved 4 assignments from Social to Associate, then deleted Social.",
        ),
      ).not.toBeNull(),
    );
  });
});
