"use client";

import { useCallback, useEffect, useState } from "react";
import { Monitor } from "lucide-react";
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
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

// Per-lodge lobby display settings (LTV-035, #81). Relocated out of the retired
// /admin/display/settings page into the lodge configuration hub so the controls
// edit THE LODGE BEING VIEWED, not always the club default lodge (the MVP bug
// from old backlog #64). The lodgeId of the hub is passed straight through to
// the existing GET/PUT /api/admin/display/lodge-config route — the route always
// supported a lodgeId; the old surface just never sent it. Consolidates the
// old backlog #62 "config belongs in lodge configuration" item.

const GRANULARITY_OPTIONS = [
  { value: "", label: "Club default (first name + surname initial)" },
  { value: "FULL_NAME", label: "Full names" },
  { value: "FIRST_NAME_SURNAME_INITIAL", label: "First name + surname initial" },
  { value: "FIRST_NAME_ONLY", label: "First names only" },
  { value: "COUNTS_ONLY", label: "Counts only (no names)" },
];

export function LodgeDisplaySettingsCard({ lodgeId }: { lodgeId: string }) {
  const [config, setConfig] = useState<Array<{ key: string; value: string }>>([]);
  const [granularity, setGranularity] = useState<string>("");
  const [notice, setNotice] = useState<string>("");
  const [showGuestPhones, setShowGuestPhones] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);
  // The lobby display config writes to /api/admin/display/lodge-config (area
  // "lodge"), so gate the editor on lodge:edit — a lodge:view admin reads but
  // cannot change (#1940).
  const canEdit = useAdminAreaEditAccess("lodge");

  const loadSettings = useCallback(async () => {
    const response = await fetch(
      `/api/admin/display/lodge-config?lodgeId=${encodeURIComponent(lodgeId)}`,
    );
    if (response.ok) {
      const body = (await response.json()) as {
        displayConfig: Record<string, string>;
        displayNameGranularity: string | null;
        displayNotice: string | null;
        showGuestPhonesOnScreens: boolean;
      };
      setConfig(
        Object.entries(body.displayConfig).map(([key, value]) => ({ key, value })),
      );
      setGranularity(body.displayNameGranularity ?? "");
      setNotice(body.displayNotice ?? "");
      setShowGuestPhones(body.showGuestPhonesOnScreens ?? false);
    }
  }, [lodgeId]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  async function saveSettings() {
    setMessage(null);
    const displayConfig: Record<string, string> = {};
    for (const entry of config) {
      if (entry.key.trim().length === 0) continue;
      displayConfig[entry.key.trim()] = entry.value;
    }
    const response = await fetch("/api/admin/display/lodge-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lodgeId,
        displayConfig,
        displayNameGranularity: granularity === "" ? null : granularity,
        displayNotice: notice.trim() === "" ? null : notice,
        showGuestPhonesOnScreens: showGuestPhones,
      }),
    });
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    // A stale tab whose permissions were narrowed after load surfaces the
    // persistent forbidden-save reason rather than the generic failure (#1940).
    setMessage(
      response.ok
        ? "Display settings saved."
        : response.status === 403
          ? ADMIN_FORBIDDEN_SAVE_REASON
          : body?.error ?? "Save failed",
    );
    if (response.ok) await loadSettings();
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the card's `space-y-*`
    stack so the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view the lobby display settings but cannot change
      them. Lodge edit access is required.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Monitor className="h-4 w-4" />
          Lobby display
        </CardTitle>
        <CardDescription>
          Per-lodge lobby display settings for this lodge. Guest name
          granularity is enforced in the display data feed itself, so no
          template can show more than it allows.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="granularity">Guest name display</Label>
          <select
            id="granularity"
            className="border-input bg-background h-9 rounded-md border px-3 text-sm"
            value={granularity}
            disabled={!canEdit}
            onChange={(event) => setGranularity(event.target.value)}
          >
            {GRANULARITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-muted-foreground text-xs">
            Enforced in the display data feed itself — no template can show more
            than this allows. Bookings that include children always collapse to
            a family label.
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="display-notice">Committee notice</Label>
          <textarea
            id="display-notice"
            className="border-input bg-background min-h-24 w-full rounded-md border p-3 text-sm"
            maxLength={2000}
            placeholder="A free-text notice shown by the notice module. {{config:key}} placeholders work here."
            value={notice}
            disabled={!canEdit}
            onChange={(event) => setNotice(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            Shown wherever a template places the notice module; leave empty to
            skip the module entirely.
          </p>
        </div>

        <div className="space-y-1">
          <div className="flex items-start gap-2">
            <Checkbox
              id="show-guest-phones"
              className="mt-0.5"
              checked={showGuestPhones}
              disabled={!canEdit}
              onCheckedChange={(checked) => setShowGuestPhones(checked)}
            />
            <Label htmlFor="show-guest-phones" className="font-normal">
              Show guest phone numbers on the lobby display
            </Label>
          </div>
          <p className="text-muted-foreground text-xs">
            Off by default. A number appears on the public display only when this
            is on AND the member has opted in on their profile AND they are an
            adult. The staff check-in kiosk always shows adult contact numbers
            regardless of this setting.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Config values (used as {"{{config:key}}"} in templates)</Label>
          {config.map((entry, index) => (
            <div key={index} className="flex gap-2">
              <Input
                className="w-48"
                placeholder="wifi-code"
                value={entry.key}
                disabled={!canEdit}
                onChange={(event) =>
                  setConfig((current) =>
                    current.map((row, i) =>
                      i === index ? { ...row, key: event.target.value } : row,
                    ),
                  )
                }
              />
              <Input
                className="flex-1"
                placeholder="value"
                value={entry.value}
                disabled={!canEdit}
                onChange={(event) =>
                  setConfig((current) =>
                    current.map((row, i) =>
                      i === index ? { ...row, value: event.target.value } : row,
                    ),
                  )
                }
              />
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                variant="outline"
                onClick={() =>
                  setConfig((current) => current.filter((_, i) => i !== index))
                }
              >
                Remove
              </ViewOnlyActionButton>
            </div>
          ))}
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            variant="outline"
            onClick={() => setConfig((current) => [...current, { key: "", value: "" }])}
          >
            Add value
          </ViewOnlyActionButton>
        </div>

        {message && <p className="text-sm font-medium">{message}</p>}

        <ViewOnlyActionButton canEdit={canEdit} describeReason={false} onClick={() => void saveSettings()}>
          Save display settings
        </ViewOnlyActionButton>
      </CardContent>
    </Card>
    </div>
  );
}
