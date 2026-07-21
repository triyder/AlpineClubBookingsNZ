"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

type PhotoDisplay = "NONE" | "CIRCLE" | "SQUARE";

/**
 * Full public-content settings shape returned by the API. Held verbatim so the
 * committee-photo save can PUT the whole object back (the endpoint's schema is
 * strict) with only `committeePhotoDisplay` changed — no other visibility
 * setting is disturbed.
 */
type PublicContentSettings = {
  membershipTypes: boolean;
  entranceFees: boolean;
  hutFees: boolean;
  bookingPolicySummary: boolean;
  cancellationPolicy: boolean;
  annualFees: boolean;
  showBookNow: boolean;
  bookNowTarget: "BOOKING_FLOW" | "PAGE";
  bookNowPageId: string | null;
  committeePhotoDisplay: PhotoDisplay;
};

/**
 * Committee-roster photo display + shape (epic #171, MP5). The same global
 * `PublicContentSettings.committeePhotoDisplay` setting also lives on the Page
 * Content admin; this is a convenience copy so it can be set from the committee
 * screen too. Gated on `content:edit` independently of the committee page's
 * membership gate — a membership admin without content edit sees it read-only.
 */
export function CommitteePhotoDisplayControl() {
  const selectId = useId();
  const viewOnlyReasonId = useId();
  const canEdit = useAdminAreaEditAccess("content");
  const [settings, setSettings] = useState<PublicContentSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(() => {
    setLoadFailed(false);
    fetch("/api/admin/public-content-settings")
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((data) => setSettings(data.settings as PublicContentSettings))
      .catch(() => setLoadFailed(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!settings || !canEdit) return;
    setSaving(true);
    try {
      const response = await fetch("/api/admin/public-content-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error);
      }
      toast.success("Committee photo display updated.");
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : "Could not update committee photo display.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Committee Photos</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          Whether published committee members&apos; photos appear on the public
          committee roster, and their shape. Members without a photo show their
          initials. (This is the same setting as under Site Appearance &amp;
          Content &rarr; Page Content.)
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {loadFailed ? (
          <div className="space-y-3">
            <p className="text-sm text-danger">
              Could not load the committee photo setting.
            </p>
            <Button variant="outline" onClick={load}>
              Retry
            </Button>
          </div>
        ) : settings === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            {!canEdit ? (
              <div id={viewOnlyReasonId}>
                <AdminViewOnlyNotice canEdit={canEdit}>
                  Content view access can see this setting; content edit access
                  is required to change it.
                </AdminViewOnlyNotice>
              </div>
            ) : null}
            <div className="max-w-sm space-y-1">
              <label htmlFor={selectId} className="text-sm font-medium">
                Committee photo display
              </label>
              <select
                id={selectId}
                className="w-full rounded-md border p-2 text-sm"
                value={settings.committeePhotoDisplay}
                disabled={!canEdit || saving}
                aria-describedby={!canEdit ? viewOnlyReasonId : undefined}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    committeePhotoDisplay: event.target.value as PhotoDisplay,
                  })
                }
              >
                <option value="NONE">Don&apos;t show photos</option>
                <option value="CIRCLE">Show photos (circular)</option>
                <option value="SQUARE">Show photos (square)</option>
              </select>
            </div>
            <ViewOnlyActionButton
              canEdit={canEdit}
              disabled={saving}
              onClick={save}
            >
              {saving ? "Saving…" : "Save photo display"}
            </ViewOnlyActionButton>
          </>
        )}
      </CardContent>
    </Card>
  );
}
