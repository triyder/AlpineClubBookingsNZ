"use client";

import type { AgeTier } from "@prisma/client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  applyPrimaryXeroContactGroupSelection,
  buildAvailableAcceptedXeroContactGroups,
} from "@/lib/age-tier-settings-xero-groups";

type AgeTierRow = {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  subscriptionRequiredForBooking: boolean;
  familyGroupRequestCreateMemberAllowed: boolean;
  xeroContactGroupId: string | null;
  xeroContactGroupName: string | null;
  xeroAcceptedContactGroups: Array<{
    groupId: string;
    groupName: string | null;
  }>;
  sortOrder: number;
};

type XeroContactGroup = {
  id: string;
  name: string;
  contactCount: number;
};

const DEFAULT_SETTINGS: AgeTierRow[] = [
  {
    tier: "INFANT",
    minAge: 0,
    maxAge: 4,
    label: "Infant (under 5)",
    subscriptionRequiredForBooking: false,
    familyGroupRequestCreateMemberAllowed: true,
    xeroContactGroupId: null,
    xeroContactGroupName: null,
    xeroAcceptedContactGroups: [],
    sortOrder: 0,
  },
  {
    tier: "CHILD",
    minAge: 5,
    maxAge: 9,
    label: "Child (5-9)",
    subscriptionRequiredForBooking: false,
    familyGroupRequestCreateMemberAllowed: true,
    xeroContactGroupId: null,
    xeroContactGroupName: null,
    xeroAcceptedContactGroups: [],
    sortOrder: 1,
  },
  {
    tier: "YOUTH",
    minAge: 10,
    maxAge: 17,
    label: "Youth (10-17)",
    subscriptionRequiredForBooking: true,
    familyGroupRequestCreateMemberAllowed: false,
    xeroContactGroupId: null,
    xeroContactGroupName: null,
    xeroAcceptedContactGroups: [],
    sortOrder: 2,
  },
  {
    tier: "ADULT",
    minAge: 18,
    maxAge: null,
    label: "Adult (18+)",
    subscriptionRequiredForBooking: true,
    familyGroupRequestCreateMemberAllowed: false,
    xeroContactGroupId: null,
    xeroContactGroupName: null,
    xeroAcceptedContactGroups: [],
    sortOrder: 3,
  },
];

function normalizeAgeTierRows(rows: AgeTierRow[]): AgeTierRow[] {
  return rows.map((row) => ({
    ...row,
    subscriptionRequiredForBooking: row.subscriptionRequiredForBooking ?? true,
    familyGroupRequestCreateMemberAllowed:
      row.familyGroupRequestCreateMemberAllowed ?? false,
    xeroAcceptedContactGroups: Array.isArray(row.xeroAcceptedContactGroups)
      ? row.xeroAcceptedContactGroups
      : [],
  }));
}

export default function AgeTierSettingsPage() {
  const [settings, setSettings] = useState<AgeTierRow[]>([]);
  const [savedSettings, setSavedSettings] = useState<AgeTierRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const [xeroGroups, setXeroGroups] = useState<XeroContactGroup[]>([]);
  const [loadingXeroGroups, setLoadingXeroGroups] = useState(true);
  const [refreshingXeroGroups, setRefreshingXeroGroups] = useState(false);
  const [xeroGroupsError, setXeroGroupsError] = useState<string | null>(null);

  async function loadXeroGroups(refreshFromXero = false) {
    if (refreshFromXero) {
      setRefreshingXeroGroups(true);
    } else {
      setLoadingXeroGroups(true);
    }
    setXeroGroupsError(null);

    try {
      const res = await fetch(
        `/api/admin/xero/contact-groups${refreshFromXero ? "?refresh=1" : ""}`
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? "Failed to load Xero contact groups");
      }
      setXeroGroups(data?.groups ?? []);
    } catch (loadError) {
      setXeroGroupsError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load Xero contact groups"
      );
    } finally {
      setLoadingXeroGroups(false);
      setRefreshingXeroGroups(false);
    }
  }

  useEffect(() => {
    fetch("/api/admin/age-tier-settings")
      .then((r) => r.json())
      .then((d) => {
        const rows = d.settings ?? [];
        const data = normalizeAgeTierRows(rows.length > 0 ? rows : DEFAULT_SETTINGS);
        setSettings(data);
        setSavedSettings(data);
      })
      .catch(() => setError("Failed to load settings"))
      .finally(() => setLoading(false));

    void loadXeroGroups();
  }, []);

  const sorted = [...settings].sort((a, b) => a.sortOrder - b.sortOrder);
  const lastTier = sorted[sorted.length - 1];

  function updateRow(
    tier: string,
    field: keyof AgeTierRow,
    value: string | number | boolean | null
  ) {
    setSettings((prev) =>
      prev.map((setting) =>
        setting.tier === tier ? { ...setting, [field]: value } : setting
      )
    );
    setSuccess(false);
    setError(null);
  }

  function updateXeroContactGroup(tier: AgeTier, groupId: string) {
    const existingGroup = settings.find((setting) => setting.tier === tier);
    const selectedGroup =
      groupId === "__none__"
        ? null
        : xeroGroups.find((group) => group.id === groupId) ??
          (existingGroup?.xeroContactGroupId === groupId
            ? {
                id: existingGroup.xeroContactGroupId,
                name:
                  existingGroup.xeroContactGroupName ?? existingGroup.xeroContactGroupId,
              }
            : null);

    setSettings((prev) =>
      applyPrimaryXeroContactGroupSelection(prev, tier, selectedGroup)
    );
    setSuccess(false);
    setError(null);
  }

  function toggleAcceptedXeroContactGroup(
    tier: AgeTier,
    groupId: string,
    checked: boolean
  ) {
    const selectedGroup = xeroGroups.find((group) => group.id === groupId) ?? null;

    setSettings((prev) =>
      prev.map((setting) => {
        if (setting.tier !== tier) {
          return setting;
        }

        const nextAcceptedGroups = checked
          ? [
              ...setting.xeroAcceptedContactGroups.filter((group) => group.groupId !== groupId),
              {
                groupId,
                groupName: selectedGroup?.name ?? groupId,
              },
            ]
          : setting.xeroAcceptedContactGroups.filter((group) => group.groupId !== groupId);

        return {
          ...setting,
          xeroAcceptedContactGroups: nextAcceptedGroups.sort((left, right) =>
            (left.groupName ?? left.groupId).localeCompare(right.groupName ?? right.groupId)
          ),
        };
      })
    );
    setSuccess(false);
    setError(null);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(false);

    const bySort = [...settings].sort((a, b) => a.sortOrder - b.sortOrder);
    const payload = bySort.map((setting, index) => {
      const next = bySort[index + 1];
      return {
        ...setting,
        maxAge: next ? next.minAge - 1 : null,
      };
    });

    try {
      const res = await fetch("/api/admin/age-tier-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: payload }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save");
      } else {
        setSettings(data.settings);
        setSavedSettings(data.settings);
        setEditing(false);
        setSuccess(true);
      }
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setSettings(savedSettings);
    setEditing(false);
    setError(null);
    setSuccess(false);
  }

  return (
    <div className="p-6 space-y-6">
      <AdminPageHeader
        title="Age Group Settings"
        description={
          <>
            Configure the age boundaries for each membership tier. The highest
            tier has no upper limit. MaxAge for each tier is automatically set to
            the next tier&apos;s MinAge minus 1. Optional Xero contact-group
            mappings drive managed Xero contact-group allocation for linked
            members.
          </>
        }
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Age Tier Boundaries</CardTitle>
          {!editing && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(true);
                setSuccess(false);
              }}
            >
              Edit
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-6">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading settings...</p>
          ) : null}

          <div className="flex flex-col gap-3 rounded-md border bg-muted p-4 md:flex-row md:items-center md:justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">Xero Contact Groups</p>
              <p className="text-sm text-muted-foreground">
                Choose one primary group per age tier for outbound sync, then optionally
                add extra accepted groups that should also count as valid for mismatch
                checks.
              </p>
              {loadingXeroGroups ? (
                <p className="text-xs text-muted-foreground">Loading cached Xero contact groups...</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {xeroGroups.length > 0
                    ? `${xeroGroups.length} cached Xero group${xeroGroups.length === 1 ? "" : "s"} available.`
                    : "No cached Xero contact groups available yet."}
                </p>
              )}
              {xeroGroupsError ? (
                <p className="text-xs text-danger">{xeroGroupsError}</p>
              ) : null}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadXeroGroups(true)}
              disabled={refreshingXeroGroups}
            >
              {refreshingXeroGroups ? "Refreshing..." : "Refresh Xero Groups"}
            </Button>
          </div>

          {sorted.map((setting) => {
            const availableAcceptedGroups = buildAvailableAcceptedXeroContactGroups(
              settings,
              setting.tier,
              xeroGroups
            );
            const isLastTier = lastTier && setting.tier === lastTier.tier;
            const maxAgeDisplay = isLastTier
              ? "No limit"
              : String(
                  (sorted.find((row) => row.sortOrder === setting.sortOrder + 1)
                    ?.minAge ?? 0) - 1
                );
            const labelInputId = `age-tier-label-${setting.tier}`;
            const minAgeInputId = `age-tier-min-age-${setting.tier}`;
            const maxAgeInputId = `age-tier-max-age-${setting.tier}`;
            const primaryGroupInputId = `age-tier-primary-group-${setting.tier}`;
            const subscriptionInputId = `subscription-required-${setting.tier}`;
            const familyRequestCreateInputId =
              `family-request-create-member-${setting.tier}`;

            return (
              <div
                key={setting.tier}
                className="space-y-4 border-b pb-5 last:border-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {setting.tier}
                    </p>
                    <p className="text-sm text-muted-foreground">{setting.label}</p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Ages {setting.minAge}
                    {isLastTier ? "+" : `-${maxAgeDisplay}`}
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-[minmax(12rem,1.25fr)_minmax(7rem,0.55fr)_minmax(7rem,0.55fr)_minmax(15rem,1.65fr)]">
                  <div className="space-y-1">
                    <Label htmlFor={labelInputId}>Label</Label>
                    <Input
                      id={labelInputId}
                      value={setting.label}
                      onChange={(event) =>
                        updateRow(setting.tier, "label", event.target.value)
                      }
                      disabled={!editing}
                      className={!editing ? "bg-muted text-foreground" : ""}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={minAgeInputId}>Min Age (years)</Label>
                    <Input
                      id={minAgeInputId}
                      type="number"
                      min={0}
                      value={setting.minAge}
                      onChange={(event) =>
                        updateRow(
                          setting.tier,
                          "minAge",
                          parseInt(event.target.value, 10)
                        )
                      }
                      disabled={!editing}
                      className={!editing ? "bg-muted text-foreground" : ""}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={maxAgeInputId}>Max Age (years)</Label>
                    <Input
                      id={maxAgeInputId}
                      type="text"
                      disabled
                      value={maxAgeDisplay}
                      className="bg-muted text-muted-foreground"
                    />
                    {!isLastTier ? (
                      <p className="text-xs text-muted-foreground">From next min age</p>
                    ) : null}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={primaryGroupInputId}>
                      Primary Xero Contact Group
                    </Label>
                    <Select
                      value={setting.xeroContactGroupId ?? "__none__"}
                      onValueChange={(value) => updateXeroContactGroup(setting.tier, value)}
                      disabled={!editing || loadingXeroGroups || refreshingXeroGroups}
                    >
                      <SelectTrigger
                        id={primaryGroupInputId}
                        className={!editing ? "bg-muted text-foreground" : ""}
                      >
                        <SelectValue placeholder="Not mapped" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Not mapped</SelectItem>
                        {setting.xeroContactGroupId &&
                        !xeroGroups.some(
                          (group) => group.id === setting.xeroContactGroupId
                        ) ? (
                          <SelectItem value={setting.xeroContactGroupId}>
                            {setting.xeroContactGroupName ?? setting.xeroContactGroupId}
                          </SelectItem>
                        ) : null}
                        {xeroGroups.map((group) => (
                          <SelectItem key={group.id} value={group.id}>
                            {group.name} ({group.contactCount})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Linked members without any accepted tier group will be added to this
                      group by default.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(16rem,20rem)_minmax(16rem,22rem)_1fr]">
                  <div className="flex items-start gap-3 rounded-md border bg-muted p-3">
                    <Checkbox
                      id={subscriptionInputId}
                      checked={setting.subscriptionRequiredForBooking}
                      onCheckedChange={(checked) =>
                        updateRow(
                          setting.tier,
                          "subscriptionRequiredForBooking",
                          checked === true
                        )
                      }
                      disabled={!editing}
                    />
                    <div className="space-y-1">
                      <Label htmlFor={subscriptionInputId}>
                        Subscription Required for Booking
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Requires a paid subscription before members in this tier can be
                        booked as owners or member guests.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 rounded-md border bg-muted p-3">
                    <Checkbox
                      id={familyRequestCreateInputId}
                      checked={setting.familyGroupRequestCreateMemberAllowed}
                      onCheckedChange={(checked) =>
                        updateRow(
                          setting.tier,
                          "familyGroupRequestCreateMemberAllowed",
                          checked === true
                        )
                      }
                      disabled={!editing}
                    />
                    <div className="space-y-1">
                      <Label htmlFor={familyRequestCreateInputId}>
                        Allow admin-created members from family group requests
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Lets admins approve a pending family request by creating a
                        non-login dependant when the request DOB maps to this tier.
                      </p>
                    </div>
                  </div>

                  <div className="rounded-md border bg-muted p-3">
                    <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-1">
                        <Label>Additional Accepted Xero Groups</Label>
                        <p className="text-xs text-muted-foreground">
                          Special-purpose groups that still count as valid for this tier.
                        </p>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {setting.xeroAcceptedContactGroups.length} accepted
                      </p>
                    </div>
                    {availableAcceptedGroups.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No other eligible Xero contact groups available.
                      </p>
                    ) : (
                      <div className="max-h-36 overflow-y-auto pr-1">
                        <div className="flex flex-wrap gap-2">
                          {availableAcceptedGroups.map((group) => {
                            const checked = setting.xeroAcceptedContactGroups.some(
                              (candidate) => candidate.groupId === group.id
                            );
                            const acceptedGroupInputId = `accepted-group-${setting.tier}-${group.id}`;

                            return (
                              <label
                                key={group.id}
                                htmlFor={acceptedGroupInputId}
                                className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-sm text-card-foreground"
                              >
                                <Checkbox
                                  id={acceptedGroupInputId}
                                  checked={checked}
                                  onCheckedChange={(nextChecked) =>
                                    toggleAcceptedXeroContactGroup(
                                      setting.tier,
                                      group.id,
                                      nextChecked === true
                                    )
                                  }
                                  disabled={!editing || loadingXeroGroups || refreshingXeroGroups}
                                />
                                <span className="min-w-0 truncate text-foreground">
                                  {group.name}
                                  {group.contactCount > 0
                                    ? ` (${group.contactCount})`
                                    : ""}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {error ? (
            <div className="rounded-md border border-danger/20 bg-danger-muted p-3 text-sm text-danger">
              {error}
            </div>
          ) : null}
          {success ? (
            <div className="rounded-md border border-success/20 bg-success-muted p-3 text-sm text-success">
              Age tier settings saved successfully.
            </div>
          ) : null}

          {editing ? (
            <div className="flex gap-3">
              <Button onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save Changes"}
              </Button>
              <Button variant="outline" onClick={handleCancel} disabled={saving}>
                Cancel
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Current Boundaries</CardTitle>
        </CardHeader>
        <CardContent>
          <AdminDataTable>
            <TableHeader>
              <TableRow>
                <TableHead>Tier</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Age Range</TableHead>
                <TableHead>Booking Subscription</TableHead>
                <TableHead>Family Request Creation</TableHead>
                <TableHead>Xero Group</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((setting) => (
                <TableRow key={setting.tier}>
                  <TableCell className="font-medium">{setting.tier}</TableCell>
                  <TableCell>{setting.label}</TableCell>
                  <TableCell>
                    {setting.maxAge !== null
                      ? `${setting.minAge} – ${setting.maxAge}`
                      : `${setting.minAge}+`}
                  </TableCell>
                  <TableCell>
                    {setting.subscriptionRequiredForBooking ? "Required" : "Not required"}
                  </TableCell>
                  <TableCell>
                    {setting.familyGroupRequestCreateMemberAllowed
                      ? "Allowed"
                      : "Link existing only"}
                  </TableCell>
                  <TableCell>
                    {setting.xeroContactGroupName ?? setting.xeroContactGroupId ? (
                      <span>
                        {setting.xeroContactGroupName ?? setting.xeroContactGroupId} (default)
                        {setting.xeroAcceptedContactGroups.length > 0
                          ? `; accepts ${setting.xeroAcceptedContactGroups
                              .map((group) => group.groupName ?? group.groupId)
                              .join(", ")}`
                          : ""}
                      </span>
                    ) : setting.xeroAcceptedContactGroups.length > 0 ? (
                      setting.xeroAcceptedContactGroups
                        .map((group) => group.groupName ?? group.groupId)
                        .join(", ")
                    ) : (
                      "Not mapped"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </AdminDataTable>
        </CardContent>
      </Card>
    </div>
  );
}
