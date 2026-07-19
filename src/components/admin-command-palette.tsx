"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import {
  getAdminFeatureSearchIndex,
  type AdminFeatureSearchEntry,
} from "@/components/admin-sidebar";
import type { FeatureFlags } from "@/config/schema";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import { ADMIN_COMMAND_PALETTE_OPEN_EVENT } from "@/lib/admin-command-palette-events";

/** Fallback heading for entries whose sidebar section has no label. */
const UNGROUPED_SECTION = "General";

function groupBySection(
  entries: AdminFeatureSearchEntry[],
): Array<{ section: string; entries: AdminFeatureSearchEntry[] }> {
  const groups: Array<{ section: string; entries: AdminFeatureSearchEntry[] }> =
    [];
  const indexBySection = new Map<string, number>();

  for (const entry of entries) {
    const section = entry.section ?? UNGROUPED_SECTION;
    let idx = indexBySection.get(section);
    if (idx === undefined) {
      idx = groups.length;
      indexBySection.set(section, idx);
      groups.push({ section, entries: [] });
    }
    groups[idx].entries.push(entry);
  }

  return groups;
}

/**
 * The string cmdk fuzzy-matches against for an entry. Deliberately built from
 * human-readable fields (label, section, keywords) and NOT the href: several
 * hrefs are deep links carrying query strings (e.g. the unpaid-stays views
 * whose href contains `PAYMENT_PENDING`), and scoring against that raw href
 * would surface them for unrelated searches like "payments". Navigation still
 * uses the real href via the onSelect closure.
 */
function searchValue(entry: AdminFeatureSearchEntry): string {
  return [entry.label, entry.section, ...(entry.keywords ?? [])]
    .filter(Boolean)
    .join(" ");
}

export function AdminCommandPalette({
  features,
  permissionMatrix,
  isFullAdmin,
  hutLeaderLabel = "Hut Leader",
}: {
  features: FeatureFlags;
  permissionMatrix?: AdminPermissionMatrix;
  isFullAdmin?: boolean;
  hutLeaderLabel?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  // The control that had focus when the palette opened, so we can restore focus
  // there on close (a11y). Radix cannot do this itself without a DialogTrigger,
  // and this palette opens from a keyboard shortcut or a detached window event.
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // The index is derived from getVisibleAdminNavSections (via
  // getAdminFeatureSearchIndex), so it already reflects EXACTLY the pages this
  // admin may see — no href here is inaccessible, on any interaction path.
  const index = useMemo(
    () =>
      getAdminFeatureSearchIndex(
        features,
        permissionMatrix,
        isFullAdmin,
        hutLeaderLabel,
      ),
    [features, permissionMatrix, isFullAdmin, hutLeaderLabel],
  );

  const groups = useMemo(() => groupBySection(index), [index]);

  const openPalette = useCallback(() => {
    restoreFocusRef.current =
      (document.activeElement as HTMLElement | null) ?? null;
    setOpen(true);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (openRef.current) {
          setOpen(false);
        } else {
          openPalette();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openPalette]);

  useEffect(() => {
    window.addEventListener(ADMIN_COMMAND_PALETTE_OPEN_EVENT, openPalette);
    return () =>
      window.removeEventListener(ADMIN_COMMAND_PALETTE_OPEN_EVENT, openPalette);
  }, [openPalette]);

  const handleSelect = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Search admin features"
      description="Search the admin panel and jump straight to any page you can access."
      onCloseAutoFocus={(event) => {
        const target = restoreFocusRef.current;
        if (target && document.contains(target)) {
          event.preventDefault();
          target.focus();
        }
      }}
    >
      <CommandInput placeholder="Search admin features…" />
      <CommandList>
        <CommandEmpty>No matching admin pages.</CommandEmpty>
        {groups.map(({ section, entries }) => (
          <CommandGroup key={section} heading={section}>
            {entries.map((entry) => (
              <CommandItem
                key={entry.href}
                value={searchValue(entry)}
                onSelect={() => handleSelect(entry.href)}
                className="group"
              >
                <span className="flex-1">{entry.label}</span>
                <CommandShortcut className="opacity-0 transition-opacity group-data-[selected=true]:opacity-100">
                  <CornerDownLeft className="h-3.5 w-3.5" aria-hidden />
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
