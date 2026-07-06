// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member, Filters } from "../../_types";
import { emptyFilters } from "../../_utils";
import { MemberBulkDialog } from "../member-bulk-dialog";
import { MemberEditorDialog } from "../member-editor-dialog";
import { MemberFilterToolbar } from "../member-filter-toolbar";
import { MemberTable } from "../member-table";
import { MemberAccessRolePicker } from "@/components/member-access-role-picker";
import { buildFallbackAccessRoleOptions } from "@/lib/access-role-definitions";

// Components resolve role options via this hook (a fetch in the browser);
// tests use the static fallback options, which mirror the seeded defaults.
vi.mock("@/hooks/use-access-role-options", async () => {
  const { buildFallbackAccessRoleOptions } = await import(
    "@/lib/access-role-definitions"
  );
  const options = buildFallbackAccessRoleOptions();
  return { useAccessRoleOptions: () => options };
});

const pickerRoleOptions = buildFallbackAccessRoleOptions();

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const entranceFeeDecisionMock = vi.hoisted(() => ({
  createEntranceFeeInvoice: false,
  dueDate: "",
  selectedFee: null,
  selectedFeeId: "",
  setCreateEntranceFeeInvoice: vi.fn(),
  setDueDate: vi.fn(),
  setSelectedFeeId: vi.fn(),
  loadEntranceFeeOptions: vi.fn(),
  resetXeroEntranceFeeDecision: vi.fn(),
  entranceFeeOptions: [],
  entranceFeeOptionsLoading: false,
  entranceFeeOptionsError: "",
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({
    children,
    value,
  }: {
    children: ReactNode;
    value: string;
  }) => (
    <div role="option" aria-selected="false" data-value={value}>
      {children}
    </div>
  ),
  SelectTrigger: ({
    children,
    ...props
  }: {
    children: ReactNode;
  }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open?: boolean;
    children: ReactNode;
  }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

vi.mock("@/components/member-address-fields", () => ({
  MemberAddressFields: () => <div data-testid="member-address-fields" />,
}));

vi.mock("../member-xero-controls", () => ({
  MemberXeroControls: () => <div data-testid="member-xero-controls" />,
}));

vi.mock("../member-xero-duplicate-decision-dialog", () => ({
  MemberXeroDuplicateDecisionDialog: () => null,
}));

vi.mock("@/lib/admin-member-xero-actions", () => ({
  linkMemberXeroContact: vi.fn(),
  pushMemberToXero: vi.fn(),
  searchXeroContacts: vi.fn().mockResolvedValue([]),
  unlinkMemberXeroContact: vi.fn(),
}));

vi.mock("@/lib/admin-xero-entrance-fee", () => ({
  useXeroEntranceFeeDecision: () => entranceFeeDecisionMock,
}));

vi.mock("@/lib/use-member-fields-settings", () => ({
  useMemberFieldsSettings: () => ({
    showTitle: false,
    showGender: false,
    showOccupation: false,
  }),
}));

const baseMember: Member = {
  id: "member-1",
  title: null,
  firstName: "Alice",
  lastName: "Summit",
  gender: null,
  occupation: null,
  email: "alice@example.test",
  phoneCountryCode: null,
  phoneAreaCode: null,
  phoneNumber: null,
  dateOfBirth: "1990-01-01",
  role: "USER",
  accessRoles: ["USER"],
  ageTier: "ADULT",
  financeAccessLevel: "NONE",
  active: true,
  xeroContactId: null,
  cancelledAt: null,
  cancelledReason: null,
  lifeMemberDate: null,
  comments: null,
  archivedAt: null,
  archivedReason: null,
  xeroContactGroupsLoaded: false,
  xeroContactGroups: [],
  subscriptionStatus: "PAID",
  subscriptionXeroInvoiceId: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  joinedDate: "2026-04-01",
  forcePasswordChange: false,
  hasCompletedAccountSetup: true,
  pendingInviteExpiresAt: null,
  canLogin: true,
  streetAddressLine1: null,
  streetAddressLine2: null,
  streetCity: null,
  streetRegion: null,
  streetPostalCode: null,
  streetCountry: null,
  postalAddressLine1: null,
  postalAddressLine2: null,
  postalCity: null,
  postalRegion: null,
  postalPostalCode: null,
  postalCountry: null,
  familyGroups: [],
  currentMembershipType: null,
};

function renderMemberTable(members: Member[], canEdit = true) {
  return render(
    <MemberTable
      members={members}
      loading={false}
      debouncedSearch=""
      selectedIds={new Set()}
      canEdit={canEdit}
      sortBy="name"
      sortDir="asc"
      membersListPath="/admin/members"
      onToggleSelect={vi.fn()}
      onToggleSelectAll={vi.fn()}
      onToggleSort={vi.fn()}
      onOpenPasswordActionDialog={vi.fn()}
      onEditMember={vi.fn()}
    />,
  );
}

describe("admin member access-role UI", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ updated: 2 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows every access role and no-login state in the member table without the old finance column", () => {
    renderMemberTable([
      {
        ...baseMember,
        id: "member-all-access",
        accessRoles: [
          "USER",
          "ADMIN",
          "ADMIN_READONLY",
          "ADMIN_BOOKINGS",
          "ADMIN_MEMBERSHIP",
          "ADMIN_CONTENT",
          "LODGE",
          "FINANCE_USER",
          "FINANCE_ADMIN",
          "ORG",
        ],
      },
      {
        ...baseMember,
        id: "member-no-login",
        firstName: "No",
        lastName: "Login",
        email: "nologin@example.test",
        accessRoles: [],
        canLogin: false,
      },
    ]);

    expect(screen.getByRole("columnheader", { name: /Access/ })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /Finance Access/ })).not.toBeInTheDocument();
    expect(screen.getByText("User")).toBeInTheDocument();
    expect(screen.getByText("Full Admin")).toBeInTheDocument();
    expect(screen.getByText("Read-only Admin")).toBeInTheDocument();
    expect(screen.getByText("Booking Officer")).toBeInTheDocument();
    expect(screen.getByText("Membership Officer")).toBeInTheDocument();
    expect(screen.getByText("Content Manager")).toBeInTheDocument();
    expect(screen.getByText("Lodge")).toBeInTheDocument();
    expect(screen.getByText("Finance Viewer")).toBeInTheDocument();
    expect(screen.getByText("Treasurer")).toBeInTheDocument();
    expect(screen.getByText("Organisation")).toBeInTheDocument();
    expect(screen.getAllByText("No Login").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Treasurer").parentElement).toHaveClass(
      "flex-wrap",
    );
  });

  it("hides member write and bulk-selection controls for view-only membership access", () => {
    renderMemberTable(
      [
        {
          ...baseMember,
          familyGroups: [{ id: "family-1", name: "Summit Household" }],
        },
      ],
      false,
    );

    expect(screen.queryByLabelText("Select all members on this page")).toBeNull();
    expect(screen.queryByLabelText("Select Alice Summit")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByText("Summit Household")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Summit Household" }),
    ).not.toBeInTheDocument();
  });

  it("labels access-role list filters with the new model", () => {
    const filters: Filters = {
      ...emptyFilters,
      role: "FINANCE_ADMIN",
    };
    render(
      <MemberFilterToolbar
        search=""
        filters={filters}
        activeFilterCount={1}
        xeroFeatures={{
          liveMemberGroupLookups: false,
          autoLoadContactGroups: false,
        }}
        xeroContactGroupsList={[]}
        onSearchChange={vi.fn()}
        onSetFilter={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );

    expect(screen.getByText(/Access Role: Treasurer/)).toBeInTheDocument();
    expect(screen.queryByText("Finance Access")).not.toBeInTheDocument();
  });

  it("offers non-login member-type options in the filter toolbar", () => {
    render(
      <MemberFilterToolbar
        search=""
        filters={emptyFilters}
        activeFilterCount={0}
        xeroFeatures={{
          liveMemberGroupLookups: false,
          autoLoadContactGroups: false,
        }}
        xeroContactGroupsList={[]}
        onSearchChange={vi.fn()}
        onSetFilter={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );

    expect(screen.getByText("All Member Types")).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Non-Member" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "School" })).toBeInTheDocument();
  });

  it("labels a member-type filter chip with the friendly role name", () => {
    const filters: Filters = {
      ...emptyFilters,
      role: "NON_MEMBER",
    };
    render(
      <MemberFilterToolbar
        search=""
        filters={filters}
        activeFilterCount={1}
        xeroFeatures={{
          liveMemberGroupLookups: false,
          autoLoadContactGroups: false,
        }}
        xeroContactGroupsList={[]}
        onSearchChange={vi.fn()}
        onSetFilter={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );

    expect(screen.getByText(/Access Role: Non-Member/)).toBeInTheDocument();
  });

  it("submits bulk access changes through accessRoles instead of the legacy role field", async () => {
    const onUpdated = vi.fn();
    render(
      <MemberBulkDialog
        open
        action="set-role"
        selectedIds={new Set(["member-1", "member-2"])}
        onOpenChange={vi.fn()}
        onUpdated={onUpdated}
        onError={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(2));
    const requestBody = JSON.parse(
      String(vi.mocked(fetch).mock.calls[0]?.[1]?.body),
    );
    expect(requestBody).toEqual({
      ids: ["member-1", "member-2"],
      action: "set-role",
      accessRoles: ["USER"],
    });
    expect(requestBody).not.toHaveProperty("role");
  });

  it("clears access roles while canLogin is off and restores User when login is re-enabled", () => {
    render(
      <MemberEditorDialog
        open
        editingMember={{
          ...baseMember,
          accessRoles: ["USER", "FINANCE_ADMIN"],
          financeAccessLevel: "MANAGER",
        }}
        xeroConnected={false}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        onSuccess={vi.fn()}
        onWarning={vi.fn()}
      />,
    );

    const canLogin = screen.getByLabelText("Can Login");
    const roleCheckbox = (name: string) =>
      screen.getByRole("checkbox", {
        name: new RegExp(`^${escapeRegExp(name)}(?:\\b|Can)`),
      });

    expect(roleCheckbox("User")).toBeChecked();
    expect(roleCheckbox("Treasurer")).toBeChecked();
    expect(screen.queryByText("Finance Access")).not.toBeInTheDocument();
    expect(screen.getByText("Bookings & Beds")).toBeInTheDocument();
    expect(screen.getAllByText("Edit").length).toBeGreaterThan(0);

    fireEvent.click(canLogin);

    expect(roleCheckbox("User")).toBeDisabled();
    expect(roleCheckbox("Full Admin")).toBeDisabled();
    expect(roleCheckbox("Read-only Admin")).toBeDisabled();
    expect(roleCheckbox("Booking Officer")).toBeDisabled();
    expect(roleCheckbox("Membership Officer")).toBeDisabled();
    expect(roleCheckbox("Content Manager")).toBeDisabled();
    expect(roleCheckbox("Lodge")).toBeDisabled();
    expect(roleCheckbox("Finance Viewer")).toBeDisabled();
    expect(roleCheckbox("Treasurer")).toBeDisabled();
    expect(roleCheckbox("Organisation")).toBeDisabled();
    expect(
      screen.getByText("Access roles only apply to login-enabled records."),
    ).toBeInTheDocument();

    fireEvent.click(canLogin);

    expect(roleCheckbox("User")).toBeChecked();
    expect(roleCheckbox("Treasurer")).not.toBeChecked();
  });

  it("surfaces server field validation errors when creating a member", async () => {
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method;
      if (url === "/api/admin/members" && method === "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: "Validation failed",
              details: {
                email: ["Invalid email address"],
                dateOfBirth: ["Invalid date format"],
              },
            }),
            { status: 422, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    render(
      <MemberEditorDialog
        open
        xeroConnected={false}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        onSuccess={vi.fn()}
        onWarning={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Member" }));

    // Field-level messages surface with friendly labels, one line per field.
    expect(
      await screen.findByText(/Email: Invalid email address/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Date of birth: Invalid date format/),
    ).toBeInTheDocument();
  });
});

describe("scoped-admin gated access-role picker (#1038)", () => {
  afterEach(() => cleanup());

  it("disables privileged roles for scoped admins but leaves User/Org usable", () => {
    render(
      <MemberAccessRolePicker
        roleOptions={pickerRoleOptions}
        accessRoles={["USER"]}
        canLogin
        actorIsFullAdmin={false}
        onToggleRole={vi.fn()}
      />,
    );

    const checkboxes = screen.getAllByRole("checkbox");
    const enabled = checkboxes.filter((box) => !box.hasAttribute("disabled"));
    // Only the two unprivileged classifications stay editable.
    expect(enabled).toHaveLength(2);
    expect(
      screen.getByText(/Granting or revoking privileged roles requires Full Admin/),
    ).toBeInTheDocument();
  });

  it("locks the whole picker when the member holds a live privileged role", () => {
    render(
      <MemberAccessRolePicker
        roleOptions={pickerRoleOptions}
        accessRoles={["ADMIN"]}
        canLogin
        actorIsFullAdmin={false}
        memberPrivilege="live"
        onToggleRole={vi.fn()}
      />,
    );

    for (const box of screen.getAllByRole("checkbox")) {
      expect(box).toBeDisabled();
    }
    expect(
      screen.getByText(/Only a Full Admin can change this member's access roles/),
    ).toBeInTheDocument();
  });

  it("explains the dormant legacy-role case", () => {
    render(
      <MemberAccessRolePicker
        roleOptions={pickerRoleOptions}
        accessRoles={["USER"]}
        canLogin
        actorIsFullAdmin={false}
        memberPrivilege="dormant"
        onToggleRole={vi.fn()}
      />,
    );

    for (const box of screen.getAllByRole("checkbox")) {
      expect(box).toBeDisabled();
    }
    expect(
      screen.getByText(/dormant privileged legacy role.*requires Full Admin/),
    ).toBeInTheDocument();
  });

  it("keeps every control enabled for Full Admins (default)", () => {
    render(
      <MemberAccessRolePicker
        roleOptions={pickerRoleOptions}
        accessRoles={["USER"]}
        canLogin
        onToggleRole={vi.fn()}
      />,
    );

    for (const box of screen.getAllByRole("checkbox")) {
      expect(box).not.toBeDisabled();
    }
  });
});
