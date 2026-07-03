"use client";

import { useEffect, useState } from "react";
import {
  buildFallbackAccessRoleOptions,
  type AccessRoleOption,
} from "@/lib/access-role-definitions";

const FALLBACK_OPTIONS = buildFallbackAccessRoleOptions();

/**
 * Database-backed access-role options for admin pickers and label rendering.
 * Serves the static legacy options until the fetch resolves, so pickers stay
 * usable (enum tokens remain valid) even if the request fails.
 */
export function useAccessRoleOptions(): AccessRoleOption[] {
  const [options, setOptions] = useState<AccessRoleOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/admin/access-roles")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && Array.isArray(data?.roleOptions)) {
          setOptions(data.roleOptions as AccessRoleOption[]);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  return options ?? FALLBACK_OPTIONS;
}
