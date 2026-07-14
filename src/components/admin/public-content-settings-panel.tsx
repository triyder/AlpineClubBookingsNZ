"use client";

import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { AdminViewOnlyNotice, ViewOnlyActionButton } from "@/components/admin/view-only-action";

type Settings = {
  membershipTypes: boolean;
  entranceFees: boolean;
  hutFees: boolean;
  bookingPolicySummary: boolean;
  cancellationPolicy: boolean;
};

const labels: Array<[keyof Settings, string]> = [
  ["membershipTypes", "Membership types"],
  ["entranceFees", "Entrance fees"],
  ["hutFees", "Hut fees"],
  ["bookingPolicySummary", "Booking policy summaries"],
  ["cancellationPolicy", "Cancellation policies"],
];

export function PublicContentSettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const canEdit = useAdminAreaEditAccess("content");
  const viewOnlyReasonId = useId();
  function load() {
    setLoadFailed(false);
    void fetch("/api/admin/public-content-settings").then(async (response) => {
      if (!response.ok) throw new Error();
      setSettings((await response.json()).settings);
    }).catch(() => { setLoadFailed(true); toast.error("Could not load public content settings."); });
  }
  useEffect(() => {
    load();
    // Load once on mount; retry is explicit after an error.
  }, []);
  if (loadFailed) return <div className="space-y-3"><p className="text-sm text-danger">Could not load public content settings.</p><Button variant="outline" onClick={load}>Retry</Button></div>;
  if (!settings) return <p className="text-sm text-muted-foreground">Loading visibility settings…</p>;
  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/admin/public-content-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
      if (!response.ok) throw new Error();
      setSettings((await response.json()).settings);
      toast.success("Public content visibility updated.");
    } catch { toast.error("Could not update public content visibility."); }
    finally { setSaving(false); }
  }
  return <div className="space-y-4"><p className="text-sm text-muted-foreground">A token renders no authoritative fee or policy data until its family is enabled here. Membership types must also be individually marked for public listing.</p>{!canEdit ? <div id={viewOnlyReasonId}><AdminViewOnlyNotice>Content view access can inspect public visibility. Content edit access is required to change it.</AdminViewOnlyNotice></div> : null}<div className="grid gap-3 sm:grid-cols-2">{labels.map(([key, label]) => <label key={key} className="flex items-center gap-3 rounded-md border p-3"><input type="checkbox" checked={settings[key]} disabled={!canEdit} aria-describedby={!canEdit ? viewOnlyReasonId : undefined} onChange={(event) => setSettings({ ...settings, [key]: event.target.checked })} /><span>{label}</span></label>)}</div><ViewOnlyActionButton canEdit={canEdit} disabled={saving} onClick={save}>{saving ? "Saving…" : "Save visibility"}</ViewOnlyActionButton></div>;
}
