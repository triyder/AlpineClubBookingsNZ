"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ContactSuggestion {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  phoneNumber: string | null;
  bookingCount: number;
}

/**
 * The admin's map-or-create decision for a public booking request's owner
 * contact (issue #1255). `create` keeps today's behaviour (mint a fresh
 * non-login contact); `map` attaches the booking to an existing non-login
 * Organisation/School contact instead, reusing its Xero contact downstream.
 */
export type OwnerContactChoice =
  | { mode: "create" }
  | { mode: "map"; memberId: string; label: string };

interface BookingRequestContactPickerProps {
  requestId: string;
  choice: OwnerContactChoice;
  onChange: (choice: OwnerContactChoice) => void;
  disabled?: boolean;
}

function contactName(contact: ContactSuggestion) {
  const name = `${contact.firstName} ${contact.lastName}`.trim();
  return name || contact.email;
}

function contactLabel(contact: ContactSuggestion) {
  return `${contactName(contact)} · ${contact.email}`;
}

export function BookingRequestContactPicker({
  requestId,
  choice,
  onChange,
  disabled = false,
}: BookingRequestContactPickerProps) {
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ContactSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load likely matches once (a repeat contact email surfaces the existing
  // Organisation/School contact so the admin can map to it or create new).
  useEffect(() => {
    let active = true;
    fetch(`/api/admin/booking-requests/${requestId}/contacts`)
      .then((res) => (res.ok ? res.json() : { contacts: [] }))
      .then((data) => {
        if (active) {
          setSuggestions(Array.isArray(data.contacts) ? data.contacts : []);
        }
      })
      .catch(() => {
        if (active) setSuggestions([]);
      });
    return () => {
      active = false;
    };
  }, [requestId]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/admin/booking-requests/${requestId}/contacts?q=${encodeURIComponent(trimmed)}`
        );
        const data = res.ok ? await res.json() : { contacts: [] };
        setResults(Array.isArray(data.contacts) ? data.contacts : []);
      } catch {
        setResults([]);
      } finally {
        setSearched(true);
        setLoading(false);
      }
    }, 300);
  }, [query, requestId]);

  function selectContact(contact: ContactSuggestion) {
    onChange({ mode: "map", memberId: contact.id, label: contactLabel(contact) });
    setQuery("");
    setResults([]);
    setSearched(false);
  }

  const isMap = choice.mode === "map";

  return (
    <fieldset
      className="space-y-3 rounded-md border p-3"
      disabled={disabled}
    >
      <legend className="px-1 text-sm font-medium">Booking contact</legend>

      <div className="space-y-2 text-sm">
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name={`owner-contact-${requestId}`}
            className="mt-1"
            checked={!isMap}
            onChange={() => onChange({ mode: "create" })}
          />
          <span>
            <span className="font-medium">Create a new contact</span>
            <span className="block text-xs text-muted-foreground">
              Adds a new non-login contact from the request details (today&apos;s
              default).
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2">
          <input
            type="radio"
            name={`owner-contact-${requestId}`}
            className="mt-1"
            checked={isMap}
            onChange={() => {
              if (!isMap) {
                // Enter map mode; a contact must still be chosen below.
                onChange({ mode: "map", memberId: "", label: "" });
              }
            }}
          />
          <span>
            <span className="font-medium">
              Map to an existing Organisation/School contact
            </span>
            <span className="block text-xs text-muted-foreground">
              Reuses the existing contact (and its Xero contact) instead of
              creating a duplicate.
            </span>
          </span>
        </label>
      </div>

      {/* Selected contact chip (map mode with a chosen contact). */}
      {isMap && choice.memberId ? (
        <div className="flex items-center gap-3 rounded-md border border-primary/40 bg-card p-2">
          <div className="flex-1 text-sm">
            <p className="font-medium">Mapping to: {choice.label}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange({ mode: "map", memberId: "", label: "" })}
          >
            Change
          </Button>
        </div>
      ) : null}

      {/* Suggestions surfaced from the request's own email/name. Shown until a
          map target is chosen so the admin can spot an obvious duplicate. */}
      {suggestions.length > 0 && !(isMap && choice.memberId) ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            Possible existing contacts for this request:
          </p>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((contact) => (
              <Button
                key={contact.id}
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => selectContact(contact)}
              >
                {contactName(contact)}
                <Badge variant="outline" className="ml-2 text-[10px]">
                  {contact.role === "SCHOOL" ? "School" : "Non-member"}
                </Badge>
                {contact.bookingCount > 0 ? (
                  <span className="ml-2 text-[10px] text-muted-foreground">
                    {contact.bookingCount} booking
                    {contact.bookingCount === 1 ? "" : "s"}
                  </span>
                ) : null}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Search box (map mode, no contact chosen yet). */}
      {isMap && !choice.memberId ? (
        <div className="space-y-2">
          <Label
            htmlFor={`owner-contact-search-${requestId}`}
            className="text-xs text-muted-foreground"
          >
            Search Organisation/School contacts by name or email
          </Label>
          <Input
            id={`owner-contact-search-${requestId}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a name or email..."
          />
          {loading ? (
            <p className="text-xs text-muted-foreground">Searching...</p>
          ) : null}
          {results.length > 0 ? (
            <div className="flex flex-col gap-1">
              {results.map((contact) => (
                <button
                  key={contact.id}
                  type="button"
                  className="rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                  onClick={() => selectContact(contact)}
                >
                  <span className="font-medium">{contactName(contact)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {contact.email}
                    {contact.bookingCount > 0
                      ? ` · ${contact.bookingCount} booking${contact.bookingCount === 1 ? "" : "s"}`
                      : ""}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {searched && !loading && results.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No matching Organisation/School contacts.
            </p>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}
