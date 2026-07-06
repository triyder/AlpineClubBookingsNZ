"use client";

import { useCallback, useEffect, useState } from "react";
import type { EmailInheritanceSearchResult } from "../_types";

interface UseInheritEmailSearchParams {
  memberId: string | undefined;
  /** Search only runs while the notification-recipient block is visible. */
  enabled: boolean;
}

// Debounced search for an eligible primary adult to receive a no-login
// member's notifications. Extracted verbatim from the retired use-member-edit
// hook; `enabled` replaces its `editOpen && !form.canLogin` gate.
export function useInheritEmailSearch({
  memberId,
  enabled,
}: UseInheritEmailSearchParams) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<EmailInheritanceSearchResult[]>([]);
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] =
    useState<EmailInheritanceSearchResult | null>(null);

  useEffect(() => {
    if (!enabled || !memberId) {
      setResults([]);
      setError("");
      setSearching(false);
      return;
    }

    const query = search.trim();
    if (query.length < 2) {
      setResults([]);
      setError("");
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    setError("");

    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          q: query,
          pageSize: "8",
          inheritEmailEligible: "true",
          excludeId: memberId,
        });
        const res = await fetch(`/api/admin/members?${params.toString()}`);
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(
            data.error || "Failed to search eligible adult members",
          );
        }

        if (!cancelled) {
          setResults(
            (data.members ?? [])
              .map(
                (candidate: {
                  id: string;
                  firstName: string;
                  lastName: string;
                  email: string;
                  active: boolean;
                }) => ({
                  id: candidate.id,
                  firstName: candidate.firstName,
                  lastName: candidate.lastName,
                  email: candidate.email,
                  active: candidate.active,
                }),
              )
              .filter(
                (candidate: EmailInheritanceSearchResult) =>
                  candidate.id !== selected?.id,
              ),
          );
        }
      } catch (searchError) {
        if (!cancelled) {
          setResults([]);
          setError(
            searchError instanceof Error
              ? searchError.message
              : "Failed to search eligible adult members",
          );
        }
      } finally {
        if (!cancelled) {
          setSearching(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, memberId, search, selected?.id]);

  const resetSearch = useCallback(() => {
    setSearch("");
    setResults([]);
    setError("");
  }, []);

  const select = useCallback(
    (source: EmailInheritanceSearchResult) => {
      setSelected(source);
      resetSearch();
    },
    [resetSearch],
  );

  const clear = useCallback(() => {
    setSelected(null);
    resetSearch();
  }, [resetSearch]);

  /** Re-seed on entering edit mode from the member's current inheritance. */
  const resetTo = useCallback(
    (source: EmailInheritanceSearchResult | null) => {
      setSelected(source);
      resetSearch();
    },
    [resetSearch],
  );

  return {
    search,
    setSearch,
    results,
    error,
    searching,
    selected,
    select,
    clear,
    resetTo,
  };
}
