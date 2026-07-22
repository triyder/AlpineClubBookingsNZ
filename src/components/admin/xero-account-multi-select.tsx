"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { XeroAccount } from "@/lib/xero-admin-cache";

interface XeroAccountMultiSelectProps {
  /** Full chart of accounts (code/name/type/class). */
  accounts: XeroAccount[];
  /** Currently selected Xero account codes (upper-cased). */
  selectedCodes: string[];
  onChange: (codes: string[]) => void;
  /** Restrict the picker to accounts in this Xero class (e.g. "REVENUE"). */
  classFilter?: string;
  /**
   * Allow adding a free-typed account code when it is not present in the chart
   * of accounts. Used as a fallback when the live Xero COA cannot be loaded.
   */
  allowManualCodes?: boolean;
  disabled?: boolean;
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

export function XeroAccountMultiSelect({
  accounts,
  selectedCodes,
  onChange,
  classFilter,
  allowManualCodes = false,
  disabled = false,
}: XeroAccountMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const accountByCode = useMemo(() => {
    const map = new Map<string, XeroAccount>();
    for (const account of accounts) {
      map.set(normalizeCode(account.code), account);
    }
    return map;
  }, [accounts]);

  const selectedSet = useMemo(
    () => new Set(selectedCodes.map(normalizeCode)),
    [selectedCodes],
  );

  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const trimmedQuery = query.trim().toLowerCase();
  const options = useMemo(() => {
    return accounts
      .filter((account) => {
        if (classFilter && !showAll) {
          return account.class?.toUpperCase() === classFilter.toUpperCase();
        }
        return true;
      })
      .filter((account) => {
        if (!trimmedQuery) return true;
        return (
          account.code.toLowerCase().includes(trimmedQuery) ||
          account.name.toLowerCase().includes(trimmedQuery)
        );
      });
  }, [accounts, classFilter, showAll, trimmedQuery]);

  function toggleCode(code: string) {
    const normalized = normalizeCode(code);
    if (!normalized) return;
    const next = new Set(selectedSet);
    if (next.has(normalized)) {
      next.delete(normalized);
    } else {
      next.add(normalized);
    }
    onChange(Array.from(next));
  }

  const manualQueryCode = normalizeCode(query);
  const canAddManual =
    allowManualCodes &&
    manualQueryCode.length > 0 &&
    !accountByCode.has(manualQueryCode) &&
    !selectedSet.has(manualQueryCode);

  return (
    <div className="space-y-2" ref={containerRef}>
      <div className="flex flex-wrap gap-1.5">
        {selectedCodes.length === 0 ? (
          <span className="text-sm text-muted-foreground">No accounts selected.</span>
        ) : (
          selectedCodes.map((code) => {
            const normalized = normalizeCode(code);
            const account = accountByCode.get(normalized);
            return (
              <span
                key={normalized}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-foreground"
              >
                <span>
                  {normalized}
                  {account ? ` — ${account.name}` : ""}
                </span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => toggleCode(normalized)}
                  className="rounded-sm text-muted-foreground hover:text-accent-foreground disabled:opacity-50"
                  aria-label={`Remove account ${normalized}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            );
          })
        )}
      </div>

      <div className="relative">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
        >
          <Plus className="h-4 w-4" />
          Add account
          <ChevronDown className="h-4 w-4" />
        </Button>

        {open ? (
          <div className="absolute z-20 mt-1 w-full max-w-md rounded-md border border-border bg-card shadow-lg">
            <div className="border-b border-border p-2">
              <Input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search code or name…"
              />
              {classFilter ? (
                <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={showAll}
                    onChange={(event) => setShowAll(event.target.checked)}
                  />
                  Show all accounts (ignore {classFilter.toLowerCase()} filter)
                </label>
              ) : null}
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              {options.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  {accounts.length === 0
                    ? "No Xero accounts available."
                    : "No accounts match your search."}
                </p>
              ) : (
                options.map((account) => {
                  const normalized = normalizeCode(account.code);
                  const checked = selectedSet.has(normalized);
                  return (
                    <button
                      type="button"
                      key={normalized}
                      onClick={() => toggleCode(normalized)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent",
                        checked && "bg-accent",
                      )}
                    >
                      <span className="text-foreground">
                        <span className="font-medium">{account.code}</span> —{" "}
                        {account.name}
                      </span>
                      {checked ? (
                        <Check className="h-4 w-4 shrink-0 text-success-11" />
                      ) : null}
                    </button>
                  );
                })
              )}
              {canAddManual ? (
                <button
                  type="button"
                  onClick={() => {
                    toggleCode(manualQueryCode);
                    setQuery("");
                  }}
                  className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent"
                >
                  <Plus className="h-4 w-4" />
                  Add code “{manualQueryCode}”
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
