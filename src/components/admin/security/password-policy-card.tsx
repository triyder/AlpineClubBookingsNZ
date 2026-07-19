"use client";

import { useEffect, useState } from "react";
import { KeyRound, Loader2, RefreshCw, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  MIN_PASSWORD_LENGTH_CEILING,
  MIN_PASSWORD_LENGTH_FLOOR,
} from "@/lib/password-policy";

// Self-contained password-policy card for the Login & Security page (epic #2030,
// child #2033; edit-gated in #2103). Kept fully independent — it loads and saves
// its own state via /api/admin/security/password-policy — so the sibling
// magic-link (#2034) and Google (#2035) cards can be dropped onto the page with
// no churn here. It follows the canonical settings-section pattern: read-only on
// load, per-section Edit → Save/Cancel, Cancel reverts to the saved snapshot,
// and Refresh is hidden while editing.

// The four configurable character-class requirements, in display order.
const CLASS_FIELDS = [
  { key: "requireUppercase", label: "Require an uppercase letter (A–Z)" },
  { key: "requireLowercase", label: "Require a lowercase letter (a–z)" },
  { key: "requireDigit", label: "Require a number (0–9)" },
  { key: "requireSymbol", label: "Require a symbol (e.g. ! ? # $)" },
] as const;

type ClassField = (typeof CLASS_FIELDS)[number]["key"];

interface PolicyDraft {
  minPasswordLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
}

interface SettingsResponse {
  policy: PolicyDraft & { magicLinkTtlMinutes: number };
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

function toDraft(policy: SettingsResponse["policy"]): PolicyDraft {
  return {
    minPasswordLength: policy.minPasswordLength,
    requireUppercase: policy.requireUppercase,
    requireLowercase: policy.requireLowercase,
    requireDigit: policy.requireDigit,
    requireSymbol: policy.requireSymbol,
  };
}

function responseErrorMessage(body: unknown, fallback: string) {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as { error?: unknown }).error === "string"
  ) {
    return (body as { error: string }).error;
  }
  return fallback;
}

export function PasswordPolicyCard() {
  const canEdit = useAdminAreaEditAccess("support");
  const [saved, setSaved] = useState<PolicyDraft | null>(null);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");

  async function loadSettings() {
    setLoading(true);
    setError("");
    setSavedMessage("");
    try {
      const response = await fetch("/api/admin/security/password-policy", {
        credentials: "same-origin",
      });
      const body = (await response.json()) as SettingsResponse | { error?: string };
      if (!response.ok || !("policy" in body)) {
        throw new Error(responseErrorMessage(body, "Failed to load password policy"));
      }
      const next = toDraft(body.policy);
      setSaved(next);
      setDraft({ ...next });
      setEditing(false);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Failed to load password policy",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  const dirty =
    saved !== null &&
    draft !== null &&
    (saved.minPasswordLength !== draft.minPasswordLength ||
      CLASS_FIELDS.some(({ key }) => saved[key] !== draft[key]));

  const minLengthValid =
    draft !== null &&
    Number.isInteger(draft.minPasswordLength) &&
    draft.minPasswordLength >= MIN_PASSWORD_LENGTH_FLOOR &&
    draft.minPasswordLength <= MIN_PASSWORD_LENGTH_CEILING;

  function cancelEditing() {
    if (saved) setDraft({ ...saved });
    setError("");
    setSavedMessage("");
    setEditing(false);
  }

  function setClass(key: ClassField, value: boolean) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setSavedMessage("");
  }

  function setMinLength(raw: string) {
    const parsed = Number.parseInt(raw, 10);
    setDraft((current) =>
      current
        ? { ...current, minPasswordLength: Number.isNaN(parsed) ? 0 : parsed }
        : current,
    );
    setSavedMessage("");
  }

  async function saveSettings() {
    if (!draft || !minLengthValid) return;
    setSaving(true);
    setError("");
    setSavedMessage("");
    try {
      const response = await fetch("/api/admin/security/password-policy", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = (await response.json()) as SettingsResponse | { error?: string };
      if (!response.ok || !("policy" in body)) {
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return;
        }
        throw new Error(responseErrorMessage(body, "Failed to save password policy"));
      }
      const next = toDraft(body.policy);
      setSaved(next);
      setDraft({ ...next });
      setEditing(false);
      setSavedMessage("Password policy saved.");
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Failed to save password policy",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" />
            <div className="min-w-0 flex-1">
              <CardTitle className="text-base">Password policy</CardTitle>
              <CardDescription className="mt-1">
                Set the minimum length and required character types for member
                passwords. Rules apply the next time a member sets or changes their
                password; existing passwords keep working. To force everyone onto
                the new rules, use the &ldquo;require password change&rdquo; option
                on the member record.
              </CardDescription>
            </div>
          </div>
          {!editing && draft ? (
            <ViewOnlyActionButton
              canEdit={canEdit}
              variant="outline"
              size="sm"
              type="button"
              onClick={() => setEditing(true)}
            >
              Edit
            </ViewOnlyActionButton>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!canEdit ? (
          <AdminViewOnlyNotice canEdit={canEdit}>
            Your admin role can view login &amp; security settings but cannot change
            them. Support edit access is required.
          </AdminViewOnlyNotice>
        ) : null}

        {(error || savedMessage) && (
          <div
            role={error ? "alert" : "status"}
            className={
              error
                ? "rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
                : "rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
            }
          >
            {error || savedMessage}
          </div>
        )}

        {loading && draft === null ? (
          <div className="flex min-h-[160px] items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
          </div>
        ) : draft ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="min-password-length">Minimum password length</Label>
              <Input
                id="min-password-length"
                type="number"
                inputMode="numeric"
                min={MIN_PASSWORD_LENGTH_FLOOR}
                max={MIN_PASSWORD_LENGTH_CEILING}
                value={draft.minPasswordLength}
                onChange={(event) => setMinLength(event.target.value)}
                disabled={!editing || saving}
                className="max-w-[8rem]"
                aria-describedby="min-password-length-hint"
              />
              <p id="min-password-length-hint" className="text-xs text-slate-500">
                Between {MIN_PASSWORD_LENGTH_FLOOR} and {MIN_PASSWORD_LENGTH_CEILING}{" "}
                characters. A hard maximum of 128 characters always applies.
              </p>
              {!minLengthValid ? (
                <p className="text-xs text-destructive">
                  Enter a whole number between {MIN_PASSWORD_LENGTH_FLOOR} and{" "}
                  {MIN_PASSWORD_LENGTH_CEILING}.
                </p>
              ) : null}
            </div>

            <fieldset className="space-y-3">
              <legend className="text-sm font-medium text-slate-700">
                Required character types
              </legend>
              {CLASS_FIELDS.map(({ key, label }) => {
                const checkboxId = `password-${key}`;
                return (
                  <div key={key} className="flex items-center gap-3">
                    <Checkbox
                      id={checkboxId}
                      checked={draft[key]}
                      onCheckedChange={(checked) => setClass(key, checked === true)}
                      disabled={!editing || saving}
                    />
                    <Label htmlFor={checkboxId} className="font-normal">
                      {label}
                    </Label>
                    <Badge variant={draft[key] ? "success" : "secondary"}>
                      {draft[key] ? "On" : "Off"}
                    </Badge>
                  </div>
                );
              })}
            </fieldset>

            {editing && dirty ? (
              <p className="text-sm text-amber-700" role="status">
                You have unsaved changes.
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2 pt-2">
              {editing ? (
                <>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    type="button"
                    onClick={() => void saveSettings()}
                    disabled={!dirty || saving || !minLengthValid}
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
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void loadSettings()}
                  disabled={loading || saving}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Refresh
                </Button>
              )}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
