"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import type { ModuleSettingsValues } from "@/config/modules";
import {
  DEFAULT_MAGIC_LINK_TTL_MINUTES,
  MAGIC_LINK_TTL_MAX_MINUTES,
  MAGIC_LINK_TTL_MIN_MINUTES,
  clampMagicLinkTtlMinutes,
} from "@/lib/magic-link";

/**
 * Self-contained Login & Security card for email magic-link sign-in (#2034).
 *
 * Mounted on the Login & Security page (`/admin/security`, #2033), which loads
 * the club module settings and the configured expiry and passes them in.
 *
 * The enable/disable TOGGLE is fully wired: it persists the `magicLink` module
 * column through the existing `PUT /api/admin/modules` route (module toggles
 * have no dedicated per-key route — the whole settings object is written), so no
 * new route is introduced here.
 *
 * The link-expiry field shows the club's configured value
 * (`LoginSecuritySetting.magicLinkTtlMinutes`, #2033), which the sign-in request
 * route reads. Persisting a new value from this page requires an
 * `onSaveTtlMinutes` handler; without one the field is display-only (a settable
 * on-page control is a planned follow-up).
 */
export interface MagicLinkSecurityCardProps {
  moduleSettings: ModuleSettingsValues;
  initialTtlMinutes?: number;
  onSaveTtlMinutes?: (minutes: number) => Promise<void>;
}

export function MagicLinkSecurityCard({
  moduleSettings,
  initialTtlMinutes = DEFAULT_MAGIC_LINK_TTL_MINUTES,
  onSaveTtlMinutes,
}: MagicLinkSecurityCardProps) {
  const [enabled, setEnabled] = useState(moduleSettings.magicLink);
  const [ttlMinutes, setTtlMinutes] = useState(
    clampMagicLinkTtlMinutes(initialTtlMinutes),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedNote, setSavedNote] = useState("");

  async function persistEnabled(next: boolean) {
    setSaving(true);
    setError("");
    setSavedNote("");
    const previous = enabled;
    setEnabled(next);
    try {
      const res = await fetch("/api/admin/modules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { ...moduleSettings, magicLink: next },
        }),
      });
      if (!res.ok) {
        setEnabled(previous);
        setError("Could not update the email sign-in link setting.");
        return;
      }
      setSavedNote(
        next ? "Email sign-in link enabled." : "Email sign-in link disabled.",
      );
    } catch {
      setEnabled(previous);
      setError("Could not update the email sign-in link setting.");
    } finally {
      setSaving(false);
    }
  }

  async function persistTtl() {
    const clamped = clampMagicLinkTtlMinutes(ttlMinutes);
    setTtlMinutes(clamped);
    if (!onSaveTtlMinutes) return;
    setSaving(true);
    setError("");
    setSavedNote("");
    try {
      await onSaveTtlMinutes(clamped);
      setSavedNote(`Link expiry set to ${clamped} minutes.`);
    } catch {
      setError("Could not update the link expiry.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email sign-in link</CardTitle>
        <CardDescription>
          Let members request a single-use email link to sign in without typing
          their password. This is additive to password login — it never replaces
          it — and only ever works for existing active members with a verified
          email.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <Alert variant="error">{error}</Alert>}
        {savedNote && <Alert variant="success">{savedNote}</Alert>}

        <label className="flex items-start gap-3">
          <Checkbox
            checked={enabled}
            disabled={saving}
            onCheckedChange={persistEnabled}
            aria-label="Enable email sign-in link"
          />
          <span className="text-sm">
            <span className="font-medium">Enable email sign-in link</span>
            <span className="block text-muted-foreground">
              When on, the sign-in page shows an &ldquo;Email me a sign-in
              link&rdquo; option.
            </span>
          </span>
        </label>

        <div className="space-y-2">
          <Label htmlFor="magic-link-ttl">Link expiry (minutes)</Label>
          <div className="flex items-center gap-2">
            <Input
              id="magic-link-ttl"
              type="number"
              min={MAGIC_LINK_TTL_MIN_MINUTES}
              max={MAGIC_LINK_TTL_MAX_MINUTES}
              value={ttlMinutes}
              disabled={saving}
              onChange={(e) => setTtlMinutes(Number(e.target.value))}
              className="w-28"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving || !onSaveTtlMinutes}
              onClick={persistTtl}
            >
              Save expiry
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Sign-in links expire between {MAGIC_LINK_TTL_MIN_MINUTES} and{" "}
            {MAGIC_LINK_TTL_MAX_MINUTES} minutes after they are sent (default{" "}
            {DEFAULT_MAGIC_LINK_TTL_MINUTES}).
            {!onSaveTtlMinutes &&
              " Changing the expiry from this page is a planned follow-up."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
