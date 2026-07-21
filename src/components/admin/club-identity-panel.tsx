"use client";

import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

type Settings = {
  name: string | null;
  shortName: string | null;
  hutLeaderLabel: string | null;
  facebookUrl: string | null;
};

const fields: Array<[keyof Settings, string, string]> = [
  ["name", "Club name", "e.g. Alpine Sports Club"],
  ["shortName", "Short name", "Optional — defaults to the club name"],
  ["hutLeaderLabel", "Hut-leader label", 'Optional — defaults to "Hut Leader"'],
  ["facebookUrl", "Facebook URL", "Optional — https://www.facebook.com/yourclub"],
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

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout. The hoisted
    const is rendered in the failed/loading branches too, so the region exists
    from the first paint rather than from whenever the fetch settles. The
    `viewOnlyReasonId` wrapper is kept because the disabled inputs below still
    point their `aria-describedby` at it.
  */
  const viewOnlyBanner = (
    <div id={viewOnlyReasonId}>
      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
        Content view access can inspect club identity. Content edit access is
        required to change it.
      </AdminViewOnlySectionBanner>
    </div>
  );

  if (loadFailed)
    return (
      <div>
        {viewOnlyBanner}
        <div className="space-y-3">
          <p className="text-sm text-danger">
            Could not load club identity settings.
          </p>
          <Button variant="outline" onClick={load}>
            Retry
          </Button>
        </div>
      </div>
    );
  if (!settings)
    return (
      <div>
        {viewOnlyBanner}
        <p className="text-sm text-muted-foreground">Loading club identity…</p>
      </div>
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
          facebookUrl: settings.facebookUrl ?? "",
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
    <div>
      {viewOnlyBanner}
      <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        These override the file configuration. Leave a field blank to fall back
        to the configured default. Changes appear across the site and in emails
        within a few seconds.
      </p>
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
      <ViewOnlyActionButton canEdit={canEdit} describeReason={false} disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Save club identity"}
      </ViewOnlyActionButton>
      </div>
    </div>
  );
}
