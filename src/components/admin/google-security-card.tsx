"use client";

import { useState } from "react";
import { Loader2, Save } from "lucide-react";
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
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import type { ModuleSettingsValues } from "@/config/modules";

/**
 * Self-contained Login & Security card for Google sign-in (#2035, gated in
 * #2103).
 *
 * Mounted on the Login & Security page (`/admin/security`, #2033), which loads
 * the club module settings and whether the per-club Google credentials are
 * configured server-side.
 *
 * The card follows the canonical settings-section pattern: it loads read-only,
 * gates on `support` edit access (`useAdminAreaEditAccess`), and stages the
 * toggle behind an explicit Edit → Save/Cancel step — nothing auto-persists.
 * Save persists the `googleLogin` module column: because `PUT /api/admin/modules`
 * takes the whole strict settings object, the handler first GETs the FRESH
 * settings and merges only `googleLogin` over them, so a module another card
 * changed since page load is never clobbered. The readiness warning is keyed off
 * the STAGED value, so it previews before Save.
 */
export interface GoogleSecurityCardProps {
  moduleSettings: ModuleSettingsValues;
  credentialsConfigured: boolean;
}

class ForbiddenSaveError extends Error {}

const TOGGLE_FAIL_MESSAGE = "Could not update the Google sign-in setting.";

export function GoogleSecurityCard({
  moduleSettings,
  credentialsConfigured,
}: GoogleSecurityCardProps) {
  const canEdit = useAdminAreaEditAccess("support");

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedNote, setSavedNote] = useState("");

  const [enabled, setEnabled] = useState(moduleSettings.googleLogin);
  const [savedEnabled, setSavedEnabled] = useState(moduleSettings.googleLogin);

  const dirty = enabled !== savedEnabled;

  function startEditing() {
    setError("");
    setSavedNote("");
    setEditing(true);
  }

  function cancelEditing() {
    setEnabled(savedEnabled);
    setError("");
    setSavedNote("");
    setEditing(false);
  }

  async function handleSave() {
    if (!dirty) return;
    setSaving(true);
    setError("");
    setSavedNote("");
    try {
      // GET the FRESH settings and merge only `googleLogin`, so a module another
      // card changed since page load is never reverted by a stale snapshot.
      const freshRes = await fetch("/api/admin/modules", {
        credentials: "same-origin",
      });
      if (!freshRes.ok) {
        if (freshRes.status === 403) throw new ForbiddenSaveError();
        throw new Error(TOGGLE_FAIL_MESSAGE);
      }
      const fresh = (await freshRes.json()) as { settings: ModuleSettingsValues };
      const putRes = await fetch("/api/admin/modules", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { ...fresh.settings, googleLogin: enabled },
        }),
      });
      if (!putRes.ok) {
        if (putRes.status === 403) throw new ForbiddenSaveError();
        throw new Error(TOGGLE_FAIL_MESSAGE);
      }

      setSavedEnabled(enabled);
      setEditing(false);
      setSavedNote(enabled ? "Google sign-in enabled." : "Google sign-in disabled.");
    } catch (saveError) {
      if (saveError instanceof ForbiddenSaveError) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON);
      } else {
        setError(
          saveError instanceof Error ? saveError.message : TOGGLE_FAIL_MESSAGE,
        );
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <CardTitle>Google sign-in</CardTitle>
          <CardDescription>
            Let members sign in with a Google account they have linked from their
            profile. This is additive to password login — it never replaces it — and
            no account is ever created from Google. Unlinked Google accounts are
            refused.
          </CardDescription>
        </div>
        {!editing && (
          <ViewOnlyActionButton
            canEdit={canEdit}
            variant="outline"
            size="sm"
            onClick={startEditing}
          >
            Edit
          </ViewOnlyActionButton>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <AdminViewOnlyNotice canEdit={canEdit}>
          Your admin role can view login &amp; security settings but cannot change
          them. Support edit access is required.
        </AdminViewOnlyNotice>

        {error && <Alert variant="error">{error}</Alert>}
        {savedNote && <Alert variant="success">{savedNote}</Alert>}

        {editing && dirty && (
          <p className="text-sm text-amber-700" role="status">
            You have unsaved changes.
          </p>
        )}

        {enabled && !credentialsConfigured && (
          <Alert variant="warning" title="Google credentials not configured">
            With Google sign-in enabled, the sign-in button will not appear
            until <code>GOOGLE_CLIENT_ID</code> and{" "}
            <code>GOOGLE_CLIENT_SECRET</code> are configured server-side (your
            club&apos;s Google Cloud OAuth credentials).
          </Alert>
        )}

        <label className="flex items-start gap-3">
          <Checkbox
            checked={enabled}
            disabled={!editing || saving}
            onCheckedChange={(checked) => setEnabled(checked === true)}
            aria-label="Enable Google sign-in"
          />
          <span className="text-sm">
            <span className="font-medium">Enable Google sign-in</span>
            <span className="block text-muted-foreground">
              When on (and credentials are configured), the sign-in page shows a
              &ldquo;Continue with Google&rdquo; button, and members can link their
              Google account from their profile.
            </span>
          </span>
        </label>

        {editing && (
          <div className="flex flex-wrap gap-2 pt-2">
            <ViewOnlyActionButton
              canEdit={canEdit}
              type="button"
              onClick={() => void handleSave()}
              disabled={!dirty || saving}
            >
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Save
            </ViewOnlyActionButton>
            <Button
              type="button"
              variant="outline"
              onClick={cancelEditing}
              disabled={saving}
            >
              Cancel
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
