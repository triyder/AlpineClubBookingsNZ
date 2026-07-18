"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";

/**
 * Inline non-member booking owner (issue #1935, E9).
 *
 * The officer enters a guest's name and contact details; as they type an email
 * (or name) the server suggests existing non-login NON_MEMBER/SCHOOL contacts to
 * reuse (dedupe = suggest-and-pick, never silent reuse). The officer explicitly
 * picks "use existing" or "create new". A "no email address" toggle supports
 * walk-ins: the record stores a club-internal placeholder and all outbound
 * email to that owner is suppressed server-side.
 */

export interface NonMemberOwner {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  isPlaceholderEmail: boolean;
}

interface Suggestion {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  isPlaceholderEmail: boolean;
  role: string;
  phoneNumber: string | null;
  bookingCount: number;
}

interface Props {
  onSelected: (owner: NonMemberOwner) => void;
}

const ENDPOINT = "/api/admin/bookings/non-member-contact";

export function NonMemberContactForm({ onSelected }: Props) {
  // Reuse/create writes /api/admin/bookings/non-member-contact (bookings area,
  // route already enforces bookings:edit). Mirror that in the UI (#1997).
  const canEdit = useAdminAreaEditAccess("bookings");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [noEmail, setNoEmail] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Suggest existing contacts as the officer types an email or a last name.
  useEffect(() => {
    const emailNeedle = noEmail ? "" : email.trim();
    const nameNeedle = lastName.trim() || firstName.trim();
    if (emailNeedle.length < 2 && nameNeedle.length < 2) {
      setSuggestions([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    let cancelled = false;
    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams();
      if (emailNeedle.length >= 2) params.set("email", emailNeedle);
      if (nameNeedle.length >= 2) params.set("name", nameNeedle);
      fetch(`${ENDPOINT}?${params.toString()}`)
        .then((res) => (res.ok ? res.json() : { contacts: [] }))
        .then((data) => {
          if (!cancelled) setSuggestions(data.contacts ?? []);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [email, firstName, lastName, noEmail]);

  async function reuseExisting(contactId: string) {
    if (!canEdit) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useExistingContactId: contactId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not use that contact");
        return;
      }
      onSelected(data.contact as NonMemberOwner);
    } catch {
      setError("Could not use that contact");
    } finally {
      setSubmitting(false);
    }
  }

  async function createNew() {
    if (!canEdit) return;
    setError("");
    if (!firstName.trim() || !lastName.trim()) {
      setError("First and last name are required");
      return;
    }
    if (!noEmail && !email.trim()) {
      setError("Enter an email address, or tick 'no email address'");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: noEmail ? undefined : email.trim(),
          phone: phone.trim() || undefined,
          noEmail,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not create the contact");
        return;
      }
      onSelected(data.contact as NonMemberOwner);
    } catch {
      setError("Could not create the contact");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div>
        <p className="text-sm font-medium text-slate-900">
          Non-member booking owner
        </p>
        <p className="text-xs text-slate-600">
          Enter the guest&apos;s details. They cannot sign in and are billed at
          non-member rates — the same kind of record an approved public booking
          request creates.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="nmc-first">First name</Label>
          <Input
            id="nmc-first"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            placeholder="First name"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="nmc-last">Last name</Label>
          <Input
            id="nmc-last"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            placeholder="Last name"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="nmc-email">Email</Label>
          <Input
            id="nmc-email"
            type="email"
            value={email}
            disabled={noEmail}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={noEmail ? "No email address" : "guest@example.com"}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="nmc-phone">Phone (optional)</Label>
          <Input
            id="nmc-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone"
          />
        </div>
      </div>

      <label className="flex items-start gap-2 text-sm text-slate-800 cursor-pointer">
        <input
          type="checkbox"
          checked={noEmail}
          onChange={(e) => setNoEmail(e.target.checked)}
          className="mt-0.5 rounded border-slate-300"
        />
        <span>
          <span className="font-medium">No email address</span>
          <span className="block text-xs text-slate-600">
            For phone/walk-in guests. No booking emails are sent to this owner
            and no address is shared with Xero.
          </span>
        </span>
      </label>

      {searching && (
        <p className="text-xs text-slate-400">Searching existing contacts…</p>
      )}

      {suggestions.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-slate-600">
            Existing contacts — reuse one instead of creating a duplicate:
          </p>
          <div className="space-y-1">
            {suggestions.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-3 py-2"
              >
                <div className="text-sm">
                  <span className="font-medium text-slate-900">
                    {s.firstName} {s.lastName}
                  </span>
                  <Badge variant="outline" className="ml-2 text-[10px]">
                    {s.role}
                  </Badge>
                  <span className="block text-xs text-slate-500">
                    {s.isPlaceholderEmail ? "(no email)" : s.email} ·{" "}
                    {s.bookingCount} booking{s.bookingCount === 1 ? "" : "s"}
                  </span>
                </div>
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={submitting}
                  onClick={() => void reuseExisting(s.id)}
                >
                  Use existing
                </ViewOnlyActionButton>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="flex justify-end">
        <ViewOnlyActionButton
          canEdit={canEdit}
          type="button"
          disabled={submitting}
          onClick={() => void createNew()}
        >
          {submitting ? "Saving…" : "Create new & continue"}
        </ViewOnlyActionButton>
      </div>
    </div>
  );
}
