"use client";

import { useEffect, useState } from "react";

// Fetches the club's live password policy from the public hints endpoint
// (/api/auth/password-policy) so the reset / change-password forms show the
// active rules and validate the minimum length client-side. Falls back to the
// historical defaults (min 12, max 128) until the fetch resolves or if it fails,
// so the form is always usable — the server enforces the real policy regardless.

export interface PasswordPolicyHints {
  minPasswordLength: number;
  maxPasswordLength: number;
  hints: string[];
  loading: boolean;
}

const FALLBACK: Omit<PasswordPolicyHints, "loading"> = {
  minPasswordLength: 12,
  maxPasswordLength: 128,
  hints: ["At least 12 characters"],
};

export function usePasswordPolicyHints(): PasswordPolicyHints {
  const [state, setState] = useState<Omit<PasswordPolicyHints, "loading">>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await fetch("/api/auth/password-policy", {
          credentials: "same-origin",
        });
        if (!response.ok) return;
        const body = (await response.json()) as Partial<PasswordPolicyHints> | null;
        if (!active || !body) return;
        setState({
          minPasswordLength:
            typeof body.minPasswordLength === "number"
              ? body.minPasswordLength
              : FALLBACK.minPasswordLength,
          maxPasswordLength:
            typeof body.maxPasswordLength === "number"
              ? body.maxPasswordLength
              : FALLBACK.maxPasswordLength,
          hints:
            Array.isArray(body.hints) && body.hints.length > 0
              ? body.hints
              : FALLBACK.hints,
        });
      } catch {
        // Keep the fallback; the server still enforces the real policy.
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return { ...state, loading };
}
