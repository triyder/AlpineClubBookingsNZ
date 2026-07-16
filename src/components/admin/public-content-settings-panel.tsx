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
  showBookNow: boolean;
  bookNowTarget: "BOOKING_FLOW" | "PAGE";
  bookNowPageId: string | null;
};

type PublishedPage = { id: string; title: string; path: string };

const labels: Array<[keyof Settings, string]> = [
  ["membershipTypes", "Membership types"],
  ["entranceFees", "Joining fees"],
  ["hutFees", "Hut fees"],
  ["bookingPolicySummary", "Booking policy summaries"],
  ["cancellationPolicy", "Cancellation policies"],
];

export function PublicContentSettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [pages, setPages] = useState<PublishedPage[]>([]);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const canEdit = useAdminAreaEditAccess("content");
  const viewOnlyReasonId = useId();
  function load() {
    setLoadFailed(false);
    void fetch("/api/admin/public-content-settings").then(async (response) => {
      if (!response.ok) throw new Error();
      const data = await response.json();
      setSettings(data.settings);
      setPages(data.pages ?? []);
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
  return <div className="space-y-4"><p className="text-sm text-muted-foreground">A token renders no authoritative fee or policy data until its family is enabled here. Membership types must also be individually marked for public listing.</p>{!canEdit ? <div id={viewOnlyReasonId}><AdminViewOnlyNotice>Content view access can inspect public visibility. Content edit access is required to change it.</AdminViewOnlyNotice></div> : null}<div className="grid gap-3 sm:grid-cols-2">{labels.map(([key, label]) => <label key={key} className="flex items-center gap-3 rounded-md border p-3"><input type="checkbox" checked={settings[key] as boolean} disabled={!canEdit} aria-describedby={!canEdit ? viewOnlyReasonId : undefined} onChange={(event) => setSettings({ ...settings, [key]: event.target.checked })} /><span>{label}</span></label>)}</div>
    <div className="space-y-3 rounded-md border p-4">
      <div>
        <p className="text-sm font-medium">Book Now button</p>
        <p className="text-sm text-muted-foreground">Controls the public website header&apos;s Book Now button. A page target that is unpublished or removed falls back to the booking flow.</p>
      </div>
      <label className="flex items-center gap-3"><input type="checkbox" checked={settings.showBookNow} disabled={!canEdit} aria-describedby={!canEdit ? viewOnlyReasonId : undefined} onChange={(event) => setSettings({ ...settings, showBookNow: event.target.checked })} /><span>Show the Book Now button</span></label>
      {settings.showBookNow ? <div className="space-y-2 pl-1">
        <label className="flex items-center gap-3"><input type="radio" name="bookNowTarget" checked={settings.bookNowTarget === "BOOKING_FLOW"} disabled={!canEdit} onChange={() => setSettings({ ...settings, bookNowTarget: "BOOKING_FLOW" })} /><span>Go to the booking flow</span></label>
        <label className="flex items-center gap-3"><input type="radio" name="bookNowTarget" checked={settings.bookNowTarget === "PAGE"} disabled={!canEdit} onChange={() => setSettings({ ...settings, bookNowTarget: "PAGE" })} /><span>Go to a content page</span></label>
        {settings.bookNowTarget === "PAGE" ? <select className="w-full rounded-md border p-2 text-sm" value={settings.bookNowPageId ?? ""} disabled={!canEdit} onChange={(event) => setSettings({ ...settings, bookNowPageId: event.target.value || null })}><option value="">Select a published page…</option>{pages.map((page) => <option key={page.id} value={page.id}>{page.title} ({page.path})</option>)}</select> : null}
      </div> : null}
    </div>
    <ViewOnlyActionButton canEdit={canEdit} disabled={saving} onClick={save}>{saving ? "Saving…" : "Save visibility"}</ViewOnlyActionButton></div>;
}
