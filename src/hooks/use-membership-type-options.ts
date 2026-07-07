"use client";

import { useEffect, useState } from "react";

export interface MembershipTypeOption {
  id: string;
  name: string;
}

/**
 * Active DB membership types for the members-list "Membership Type" filter.
 * Sourced from GET /api/admin/membership-types (already ordered by the API).
 * Returns an empty list until the fetch resolves or if it fails, so the picker
 * still offers its static "All Membership Types" and "Unassigned" options.
 * Mirrors the fetch-with-fallback shape of {@link useAccessRoleOptions}.
 */
export function useMembershipTypeOptions(): MembershipTypeOption[] {
  const [options, setOptions] = useState<MembershipTypeOption[]>([]);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/admin/membership-types")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && Array.isArray(data?.membershipTypes)) {
          const active = (
            data.membershipTypes as Array<{
              id: string;
              name: string;
              isActive: boolean;
            }>
          )
            .filter((type) => type.isActive)
            .map((type) => ({ id: type.id, name: type.name }));
          setOptions(active);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  return options;
}
