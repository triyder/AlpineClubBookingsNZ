"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { isLodgeKioskAccount } from "@/lib/member-roles";
import { useDebouncedMemberSearch } from "@/hooks/use-debounced-member-search";

export interface PickedMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: string;
}

interface MemberPickerProps {
  onSelect: (member: PickedMember) => void;
  selected?: PickedMember | null;
  onClear?: () => void;
  // Copy overrides. Default to the original book-on-behalf strings so the
  // existing consumer is unchanged.
  label?: string;
  placeholder?: string;
  selectedPrefix?: string;
}

export function MemberPicker({
  onSelect,
  selected,
  onClear,
  label = "Search for a member to book on behalf of",
  placeholder = "Type a name or email...",
  selectedPrefix = "Booking on behalf of:",
}: MemberPickerProps) {
  const [query, setQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const { results: allMatches, searching: loading } = useDebouncedMemberSearch<
    PickedMember & { role?: string; accessRoles?: string[] }
  >({
    query,
    params: { active: "true", pageSize: "8" },
    // Every completed search opens the dropdown, even an empty one — the
    // "No members found" panel needs it.
    onResults: () => setShowDropdown(true),
  });

  // Filter out shared lodge kiosk logins — a device account never holds a
  // booking. Admin-role members are bookable people (the server only rejects
  // booking for yourself).
  const results = useMemo(
    () => allMatches.filter((m) => !isLodgeKioskAccount(m.role, m.accessRoles)),
    [allMatches]
  );
  // True when the search matched only lodge kiosk accounts, which are
  // filtered out — the empty state must say so rather than claiming
  // nothing matched.
  const onlyKioskMatches = allMatches.length > 0 && results.length === 0;

  useEffect(() => {
    if (query.trim().length < 2) {
      setShowDropdown(false);
    }
  }, [query]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  if (selected) {
    return (
      <div className="flex items-center gap-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
        <div className="flex-1">
          {/* Explicit text roles rather than inherited: this card's fill is
              `bg-blue-50`, which the #1248 colored-callout pass re-tints to a
              dark blue in dark mode, so `--foreground`/`--muted-foreground`
              read correctly on it in both modes (#2144). */}
          <p className="font-medium text-sm text-foreground">
            {selectedPrefix} {selected.firstName} {selected.lastName}
          </p>
          <p className="text-xs text-muted-foreground">{selected.email}</p>
        </div>
        <Badge variant="outline" className="text-xs text-muted-foreground">{selected.ageTier}</Badge>
        {onClear && (
          <Button variant="outline" size="sm" onClick={onClear}>
            Change
          </Button>
        )}
      </div>
    );
  }

  return (
    <div ref={wrapperRef} className="relative">
      <label className="block text-sm font-medium text-muted-foreground mb-1">
        {label}
      </label>
      <Input
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setShowDropdown(true)}
      />
      {loading && (
        <p className="text-xs text-muted-foreground mt-1">Searching...</p>
      )}
      {showDropdown && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-card border rounded-lg shadow-lg max-h-64 overflow-y-auto">
          {results.map((m) => (
            <button
              key={m.id}
              className="w-full text-left px-3 py-2 hover:bg-blue-50 border-b last:border-b-0 transition-colors"
              onClick={() => {
                onSelect(m);
                setShowDropdown(false);
                setQuery("");
              }}
            >
              {/* Badge renders a div, which HTML forbids inside <p> (React
                  hydration error), so the row wrapper must be a div too. */}
              <div className="text-sm font-medium">
                {m.firstName} {m.lastName}
                <Badge variant="outline" className="ml-2 text-[10px]">{m.ageTier}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">{m.email}</p>
            </button>
          ))}
        </div>
      )}
      {showDropdown && results.length === 0 && query.trim().length >= 2 && !loading && (
        <div className="absolute z-50 mt-1 w-full bg-card border rounded-lg shadow-lg p-3">
          <p className="text-sm text-muted-foreground">
            {onlyKioskMatches
              ? "Only the shared lodge kiosk login matched — it cannot hold bookings. Search for a member instead."
              : "No members found"}
          </p>
        </div>
      )}
    </div>
  );
}
