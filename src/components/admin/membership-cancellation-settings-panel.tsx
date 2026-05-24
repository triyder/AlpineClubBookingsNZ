"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface XeroGroup {
  groupId: string;
  groupName: string;
}

interface MembershipCancellationSettings {
  warningText: string;
  rejoinProcessText: string;
  xeroArchiveContactsOnCancellation: boolean;
  xeroContactGroups: Array<{
    groupId: string;
    groupName: string | null;
  }>;
}

interface EditableMembershipCancellationSettings {
  warningText: string;
  rejoinProcessText: string;
  xeroArchiveContactsOnCancellation: boolean;
  xeroContactGroups: XeroGroup[];
}

function toEditableSettings(
  settings: MembershipCancellationSettings,
): EditableMembershipCancellationSettings {
  return {
    ...settings,
    xeroContactGroups: settings.xeroContactGroups.map((group) => ({
      groupId: group.groupId,
      groupName: group.groupName ?? "",
    })),
  };
}

function responseErrorMessage(body: unknown, fallback: string) {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return fallback;
}

export function MembershipCancellationSettingsPanel() {
  const [settings, setSettings] =
    useState<EditableMembershipCancellationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/membership-cancellation-settings", {
        credentials: "same-origin",
      });
      const body = (await response.json()) as
        | { settings: MembershipCancellationSettings }
        | { error?: string };
      if (!response.ok || !("settings" in body)) {
        throw new Error(
          responseErrorMessage(body, "Failed to load membership cancellation settings"),
        );
      }
      setSettings(toEditableSettings(body.settings));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to load membership cancellation settings",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function updateGroup(index: number, updates: Partial<XeroGroup>) {
    setSettings((current) =>
      current
        ? {
            ...current,
            xeroContactGroups: current.xeroContactGroups.map((group, groupIndex) =>
              groupIndex === index ? { ...group, ...updates } : group,
            ),
          }
        : current,
    );
  }

  function addGroup() {
    setSettings((current) =>
      current
        ? {
            ...current,
            xeroContactGroups: [
              ...current.xeroContactGroups,
              { groupId: "", groupName: "" },
            ],
          }
        : current,
    );
  }

  function removeGroup(index: number) {
    setSettings((current) =>
      current
        ? {
            ...current,
            xeroContactGroups: current.xeroContactGroups.filter(
              (_group, groupIndex) => groupIndex !== index,
            ),
          }
        : current,
    );
  }

  async function saveSettings() {
    if (!settings) return;

    setSaving(true);
    try {
      const response = await fetch("/api/admin/membership-cancellation-settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...settings,
          xeroContactGroups: settings.xeroContactGroups
            .map((group) => ({
              groupId: group.groupId.trim(),
              groupName: group.groupName.trim() || null,
            }))
            .filter((group) => group.groupId),
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          responseErrorMessage(body, "Failed to save membership cancellation settings"),
        );
      }
      if (body?.settings) {
        setSettings(toEditableSettings(body.settings));
      }
      toast.success("Membership cancellation settings saved");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to save membership cancellation settings",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading || !settings) {
    return <p className="text-sm text-slate-500">Loading membership cancellation settings</p>;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="membership-cancellation-warning">Cancellation warning</Label>
        <Textarea
          id="membership-cancellation-warning"
          className="min-h-28"
          value={settings.warningText}
          onChange={(event) =>
            setSettings((current) =>
              current
                ? { ...current, warningText: event.target.value }
                : current,
            )
          }
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="membership-cancellation-rejoin">Rejoin process</Label>
        <Textarea
          id="membership-cancellation-rejoin"
          className="min-h-28"
          value={settings.rejoinProcessText}
          onChange={(event) =>
            setSettings((current) =>
              current
                ? { ...current, rejoinProcessText: event.target.value }
                : current,
            )
          }
        />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <Label className="text-base font-medium">Xero cancelled contact groups</Label>
          <Button type="button" variant="outline" size="sm" onClick={addGroup}>
            <Plus className="h-4 w-4" />
            Add Group
          </Button>
        </div>

        <div className="space-y-3">
          {settings.xeroContactGroups.map((group, index) => (
            <div
              key={index}
              className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
            >
              <div>
                <Label htmlFor={`membership-cancellation-xero-group-id-${index}`}>
                  Group ID
                </Label>
                <Input
                  id={`membership-cancellation-xero-group-id-${index}`}
                  className="mt-1"
                  value={group.groupId}
                  onChange={(event) =>
                    updateGroup(index, { groupId: event.target.value })
                  }
                />
              </div>
              <div>
                <Label htmlFor={`membership-cancellation-xero-group-name-${index}`}>
                  Group name
                </Label>
                <Input
                  id={`membership-cancellation-xero-group-name-${index}`}
                  className="mt-1"
                  value={group.groupName}
                  onChange={(event) =>
                    updateGroup(index, { groupName: event.target.value })
                  }
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="mt-6"
                aria-label="Remove Xero contact group"
                onClick={() => removeGroup(index)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id="membership-cancellation-xero-archive"
          checked={settings.xeroArchiveContactsOnCancellation}
          onCheckedChange={(checked) =>
            setSettings((current) =>
              current
                ? {
                    ...current,
                    xeroArchiveContactsOnCancellation: checked === true,
                  }
                : current,
            )
          }
        />
        <Label htmlFor="membership-cancellation-xero-archive">
          Archive Xero contacts after cancellation approval
        </Label>
      </div>

      <Button onClick={saveSettings} disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {saving ? "Saving" : "Save Cancellation Settings"}
      </Button>
    </div>
  );
}
