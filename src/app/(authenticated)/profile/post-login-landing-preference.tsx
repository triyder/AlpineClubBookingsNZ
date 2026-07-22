"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Post-login landing preference control (#2090). Rendered inside the profile
// Account Information card only for members with admin access (the server page
// gates rendering; this also self-hides if access changed since render). Mirrors
// the notification-preferences self-contained fetch pattern, saving through
// /api/profile/post-login-landing. null = follow the role default.
type Landing = "MEMBER_DASHBOARD" | "ADMIN_DASHBOARD" | null;

const DEFAULT_OPTION = "DEFAULT";

function toOption(value: Landing): string {
  return value ?? DEFAULT_OPTION;
}

function fromOption(option: string): Landing {
  return option === "MEMBER_DASHBOARD" || option === "ADMIN_DASHBOARD"
    ? option
    : null;
}

function normalizeLanding(value: unknown): Landing {
  return value === "MEMBER_DASHBOARD" || value === "ADMIN_DASHBOARD"
    ? value
    : null;
}

export function PostLoginLandingPreference() {
  const [value, setValue] = useState<Landing>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [visible, setVisible] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/profile/post-login-landing", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error())))
      .then((data) => {
        if (data?.canChoose === false) {
          setVisible(false);
        }
        setValue(normalizeLanding(data?.postLoginLanding));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  async function handleChange(option: string) {
    const next = fromOption(option);
    const previous = value;
    setValue(next);
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/profile/post-login-landing", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postLoginLanding: next }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setValue(normalizeLanding(data?.postLoginLanding));
      setSaved(true);
    } catch {
      setValue(previous);
      setError("Could not save your landing preference. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!visible) {
    return null;
  }

  return (
    <div className="space-y-2 border-t pt-3" data-testid="post-login-landing">
      <div className="space-y-0.5">
        <Label htmlFor="post-login-landing-select" className="text-sm font-medium">
          After sign-in, take me to
        </Label>
        <p className="text-xs text-muted-foreground">
          Choose where you land when you sign in. Your role default sends admins
          to their admin area and everyone else to the member dashboard.
        </p>
      </div>
      <Select
        value={toOption(value)}
        onValueChange={handleChange}
        disabled={loading || saving}
      >
        <SelectTrigger id="post-login-landing-select" className="w-full sm:w-72">
          <SelectValue placeholder="Use my role default" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_OPTION}>Use my role default</SelectItem>
          <SelectItem value="MEMBER_DASHBOARD">Member dashboard</SelectItem>
          <SelectItem value="ADMIN_DASHBOARD">Admin dashboard</SelectItem>
        </SelectContent>
      </Select>
      {saving ? (
        <p className="text-xs text-muted-foreground">Saving…</p>
      ) : error ? (
        <p className="text-xs text-danger-11">{error}</p>
      ) : saved ? (
        <p className="text-xs text-success">Saved.</p>
      ) : null}
    </div>
  );
}
