"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminForbiddenSaveNotice,
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

interface Settings {
  gateEnabled: boolean;
  minimumMembershipMonths: number;
  minimumNights: number;
  requiredSignOffs: number;
  gateEffectiveFrom: string | null;
}

export function InductionSettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [forbiddenSave, setForbiddenSave] = useState(false);
  // Nomination settings live under the membership area (the write route enforces
  // membership:edit), so gate the editor on the same area (#1940).
  const canEdit = useAdminAreaEditAccess("membership");

  useEffect(() => {
    fetch("/api/admin/membership-nomination-settings", {
      credentials: "same-origin",
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (body?.settings) setSettings(body.settings as Settings);
      })
      .catch(() => toast.error("Failed to load settings"));
  }, []);

  function update(patch: Partial<Settings>) {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    setForbiddenSave(false);
    try {
      const res = await fetch("/api/admin/membership-nomination-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          gateEnabled: settings.gateEnabled,
          minimumMembershipMonths: settings.minimumMembershipMonths,
          minimumNights: settings.minimumNights,
          requiredSignOffs: settings.requiredSignOffs,
          gateEffectiveFrom: settings.gateEffectiveFrom
            ? new Date(`${settings.gateEffectiveFrom}T00:00:00Z`).toISOString()
            : null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A stale tab whose permissions were narrowed after load surfaces a
        // persistent inline error rather than only a transient toast (#1940).
        if (res.status === 403) setForbiddenSave(true);
        toast.error(body.error ?? "Failed to save settings");
        return;
      }
      setSettings(body.settings as Settings);
      toast.success("Settings saved");
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  }

  const effectiveFromDate = settings.gateEffectiveFrom
    ? settings.gateEffectiveFrom.slice(0, 10)
    : "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nomination eligibility gate</CardTitle>
        <CardDescription>
          Control when a member is allowed to nominate new members.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!canEdit ? (
          <AdminViewOnlyNotice>
            Your admin role can view the nomination gate settings but cannot
            change them. Membership edit access is required.
          </AdminViewOnlyNotice>
        ) : null}
        <label className="flex items-start gap-3">
          <Checkbox
            className="mt-0.5"
            checked={settings.gateEnabled}
            disabled={!canEdit}
            onCheckedChange={(checked) =>
              update({ gateEnabled: checked === true })
            }
          />
          <span className="text-sm">
            <span className="font-medium">Enforce the nomination gate</span>
            <span className="block text-muted-foreground">
              When enabled, a member can only nominate once their induction is
              signed off and they meet the tenure and nights requirements below.
            </span>
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="months">Minimum membership (months)</Label>
            <Input
              id="months"
              type="number"
              min={0}
              disabled={!canEdit}
              value={settings.minimumMembershipMonths}
              onChange={(e) =>
                update({ minimumMembershipMonths: Number(e.target.value) })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nights">Minimum nights stayed</Label>
            <Input
              id="nights"
              type="number"
              min={0}
              disabled={!canEdit}
              value={settings.minimumNights}
              onChange={(e) => update({ minimumNights: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="signoffs">Sign-offs required</Label>
            <Input
              id="signoffs"
              type="number"
              min={1}
              disabled={!canEdit}
              value={settings.requiredSignOffs}
              onChange={(e) =>
                update({ requiredSignOffs: Number(e.target.value) })
              }
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="effective-from">Grandfather cutoff date</Label>
          <Input
            id="effective-from"
            type="date"
            disabled={!canEdit}
            value={effectiveFromDate}
            onChange={(e) =>
              update({ gateEffectiveFrom: e.target.value || null })
            }
          />
          <p className="text-xs text-muted-foreground">
            Members who joined before this date are exempt from the gate
            (grandfathered). Leave blank for no cutoff. Defaults to the date you
            first enable the gate.
          </p>
        </div>

        {forbiddenSave ? <AdminForbiddenSaveNotice /> : null}
        <ViewOnlyActionButton canEdit={canEdit} onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </ViewOnlyActionButton>
      </CardContent>
    </Card>
  );
}
