"use client";

import { useState, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { isLodgeKioskAccount } from "@/lib/member-roles";

interface PickedMember {
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
}

export function MemberPicker({ onSelect, selected, onClear }: MemberPickerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickedMember[]>([]);
  // True when the search matched only lodge kiosk accounts, which are
  // filtered out — the empty state must say so rather than claiming
  // nothing matched. Members holding the admin role are real people and
  // stay selectable (the server only rejects booking for yourself).
  const [onlyKioskMatches, setOnlyKioskMatches] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      setShowDropdown(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          q: query.trim(),
          active: "true",
          pageSize: "8",
        });
        const res = await fetch(`/api/admin/members?${params}`);
        if (res.ok) {
          const data = await res.json();
          // Filter out shared lodge kiosk logins — a device account never
          // holds a booking. Admin-role members are bookable people.
          const allMatches = data.members || [];
          const members = allMatches.filter(
            (m: PickedMember & { role?: string; accessRoles?: string[] }) =>
              !isLodgeKioskAccount(m.role, m.accessRoles)
          );
          setOnlyKioskMatches(allMatches.length > 0 && members.length === 0);
          setResults(members);
          setShowDropdown(true);
        }
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    }, 300);
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
          {/* Explicit dark text: the card keeps its light background in dark
              mode, where inherited text is near-white and unreadable. */}
          <p className="font-medium text-sm text-slate-900">
            Booking on behalf of: {selected.firstName} {selected.lastName}
          </p>
          <p className="text-xs text-slate-500">{selected.email}</p>
        </div>
        <Badge variant="outline" className="text-xs text-slate-700">{selected.ageTier}</Badge>
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
      <label className="block text-sm font-medium text-gray-700 mb-1">
        Search for a member to book on behalf of
      </label>
      <Input
        placeholder="Type a name or email..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setShowDropdown(true)}
      />
      {loading && (
        <p className="text-xs text-slate-400 mt-1">Searching...</p>
      )}
      {showDropdown && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white border rounded-lg shadow-lg max-h-64 overflow-y-auto">
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
              <p className="text-xs text-slate-500">{m.email}</p>
            </button>
          ))}
        </div>
      )}
      {showDropdown && results.length === 0 && query.trim().length >= 2 && !loading && (
        <div className="absolute z-50 mt-1 w-full bg-white border rounded-lg shadow-lg p-3">
          <p className="text-sm text-slate-500">
            {onlyKioskMatches
              ? "Only the shared lodge kiosk login matched — it cannot hold bookings. Search for a member instead."
              : "No members found"}
          </p>
        </div>
      )}
    </div>
  );
}
