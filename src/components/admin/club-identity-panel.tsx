"use client";

import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

type Settings = {
  name: string | null;
  shortName: string | null;
  hutLeaderLabel: string | null;
};

const fields: Array<[keyof Settings, string, string]> = [
  ["name", "Club name", "e.g. Alpine Sports Club"],
  ["shortName", "Short name", "Optional — defaults to the club name"],
  ["hutLeaderLabel", "Hut-leader label", 'Optional — defaults to "Hut Leader"'],
];

export function ClubIdentityPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const canEdit = useAdminAreaEditAccess("content");
  const viewOnlyReasonId = useId();

  function load() {
    setLoadFailed(false);
    void fetch("/api/admin/club-identity")
      .then(async (response) => {
        if (!response.ok) throw new Error();
        setSettings((await response.json()).settings);
      })
      .catch(() => {
        setLoadFailed(true);
        toast.error("Could not load club identity settings.");
      });
  }
  useEffect(() => {
    load();
  }, []);

  if (loadFailed)
    return (
      <div className="space-y-3">
        <p className="text-sm text-danger">
          Could not load club identity settings.
        </p>
        <Button variant="outline" onClick={load}>
          Retry
        </Button>
      </div>
    );
  if (!settings)
    return (
      <p className="text-sm text-muted-foreground">Loading club identity…</p>
    );

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      const response = await fetch("/api/admin/club-identity", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: settings.name ?? "",
          shortName: settings.shortName ?? "",
          hutLeaderLabel: settings.hutLeaderLabel ?? "",
        }),
      });
      if (!response.ok) throw new Error();
      setSettings((await response.json()).settings);
      toast.success("Club identity updated.");
    } catch {
      toast.error("Could not update club identity.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        These override the file configuration. Leave a field blank to fall back
        to the configured default. Changes appear across the site and in emails
        within a few seconds.
      </p>
      {!canEdit ? (
        <div id={viewOnlyReasonId}>
          <AdminViewOnlyNotice>
            Content view access can inspect club identity. Content edit access is
            required to change it.
          </AdminViewOnlyNotice>
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map(([key, label, placeholder]) => (
          <div key={key} className="space-y-1.5">
            <Label htmlFor={`club-identity-${key}`}>{label}</Label>
            <Input
              id={`club-identity-${key}`}
              value={settings[key] ?? ""}
              placeholder={placeholder}
              disabled={!canEdit}
              aria-describedby={!canEdit ? viewOnlyReasonId : undefined}
              onChange={(event) =>
                setSettings({ ...settings, [key]: event.target.value })
              }
            />
          </div>
        ))}
      </div>
      <ViewOnlyActionButton canEdit={canEdit} disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Save club identity"}
      </ViewOnlyActionButton>
    </div>
  );
}
