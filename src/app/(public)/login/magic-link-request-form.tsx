"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// "Email me a sign-in link" section, rendered on /login only when the magicLink
// module is enabled. The confirmation is ALWAYS identical regardless of whether
// the email belongs to a real, active, verified member — the endpoint is
// enumeration-safe and this UI must not leak account state either.
const CONFIRMATION_MESSAGE =
  "If that email belongs to an active account, we've sent a sign-in link. Check your inbox (and spam folder) and click the link to sign in. It can be used once and expires shortly.";

export function MagicLinkRequestForm() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } catch {
      // Deliberately swallow — the confirmation is identical on success or
      // failure so nothing about the request outcome leaks.
    } finally {
      // Always show the same confirmation, even on a network error.
      setSubmitted(true);
      setLoading(false);
    }
  }

  return (
    <div className="mt-2 border-t pt-4">
      <p className="mb-3 text-sm text-muted-foreground">
        Prefer not to type your password? We can email you a single-use sign-in
        link instead.
      </p>

      {submitted ? (
        <Alert variant="success" title="Check your email">
          {CONFIRMATION_MESSAGE}
        </Alert>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="magic-link-email">Email</Label>
            <Input
              id="magic-link-email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            className="w-full"
            disabled={loading}
          >
            {loading ? "Sending link…" : "Email me a sign-in link"}
          </Button>
        </form>
      )}
    </div>
  );
}
