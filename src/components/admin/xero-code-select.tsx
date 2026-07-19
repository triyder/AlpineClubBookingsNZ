"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { XeroAccount, XeroItem } from "@/lib/xero-admin-cache";

// Single-select siblings of XeroAccountMultiSelect (#2068). Each fee
// invoice-line component picks at most one Xero account and one item; an empty
// selection means "use the resolved default" (surfaced via `emptyLabel`). Both
// keep the disconnected-Xero manual-code fallback (allowManualCodes) so the
// editor never hard-blocks when the live Xero lists cannot be loaded.

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

interface XeroCodeOption {
  code: string;
  name: string;
}

interface XeroCodeSelectProps {
  /** Selected Xero code (upper-cased), or "" to fall back to the default. */
  value: string;
  onChange: (code: string) => void;
  options: XeroCodeOption[];
  /**
   * What the trigger shows when `value` is empty — the resolved default the
   * invoice line will use (e.g. "Default: 203 — Subscriptions Income", or
   * "Default: no item"). Also labels the "use default" reset row.
   */
  emptyLabel: string;
  /** Accessible name for the trigger button (e.g. "Account for component 1"). */
  ariaLabel: string;
  /** Noun used in the search placeholder + manual-add copy ("account"/"item"). */
  noun: string;
  /**
   * Allow choosing a free-typed code not present in `options` — the Xero
   * disconnected fallback, mirroring XeroAccountMultiSelect.allowManualCodes.
   */
  allowManualCodes?: boolean;
  disabled?: boolean;
}

export function XeroCodeSelect({
  value,
  onChange,
  options,
  emptyLabel,
  ariaLabel,
  noun,
  allowManualCodes = false,
  disabled = false,
}: XeroCodeSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const optionByCode = useMemo(() => {
    const map = new Map<string, XeroCodeOption>();
    for (const option of options) map.set(normalizeCode(option.code), option);
    return map;
  }, [options]);

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

  const normalizedValue = normalizeCode(value);
  const selectedOption = normalizedValue
    ? optionByCode.get(normalizedValue)
    : undefined;
  let triggerLabel: string;
  if (!normalizedValue) {
    triggerLabel = emptyLabel;
  } else if (selectedOption) {
    triggerLabel = `${normalizedValue} — ${selectedOption.name}`;
  } else {
    triggerLabel = normalizedValue;
  }

  const trimmedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!trimmedQuery) return options;
    return options.filter(
      (option) =>
        option.code.toLowerCase().includes(trimmedQuery) ||
        option.name.toLowerCase().includes(trimmedQuery),
    );
  }, [options, trimmedQuery]);

  const manualQueryCode = normalizeCode(query);
  const canAddManual =
    allowManualCodes &&
    manualQueryCode.length > 0 &&
    !optionByCode.has(manualQueryCode) &&
    manualQueryCode !== normalizedValue;

  function choose(code: string) {
    onChange(normalizeCode(code));
    setQuery("");
    setOpen(false);
  }

  return (
    <div className="relative" ref={containerRef}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-label={ariaLabel}
        className="w-full justify-between font-normal"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className={cn("truncate", !normalizedValue && "text-slate-500")}>
          {triggerLabel}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0" />
      </Button>

      {open ? (
        <div className="absolute z-20 mt-1 w-full max-w-md rounded-md border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 p-2">
            <Input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${noun} code or name…`}
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {/* Reset to the resolved default (empty stored code). */}
            <button
              type="button"
              onClick={() => choose("")}
              className={cn(
                "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm text-slate-600 hover:bg-slate-50",
                !normalizedValue && "bg-slate-50",
              )}
            >
              <span className="truncate">{emptyLabel}</span>
              {!normalizedValue ? (
                <Check className="h-4 w-4 shrink-0 text-green-700" />
              ) : null}
            </button>
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-sm text-slate-500">
                {options.length === 0
                  ? `No Xero ${noun}s available.`
                  : `No ${noun}s match your search.`}
              </p>
            ) : (
              filtered.map((option) => {
                const normalized = normalizeCode(option.code);
                const checked = normalized === normalizedValue;
                return (
                  <button
                    type="button"
                    key={normalized}
                    onClick={() => choose(normalized)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50",
                      checked && "bg-slate-50",
                    )}
                  >
                    <span className="truncate text-slate-800">
                      <span className="font-medium">{option.code}</span> —{" "}
                      {option.name}
                    </span>
                    {checked ? (
                      <Check className="h-4 w-4 shrink-0 text-green-700" />
                    ) : null}
                  </button>
                );
              })
            )}
            {canAddManual ? (
              <button
                type="button"
                onClick={() => choose(manualQueryCode)}
                className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              >
                <Plus className="h-4 w-4" />
                Use code “{manualQueryCode}”
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface XeroAccountSelectProps {
  accounts: XeroAccount[];
  value: string;
  onChange: (code: string) => void;
  emptyLabel: string;
  ariaLabel: string;
  /** Restrict to accounts in this Xero class (fees use REVENUE income). */
  classFilter?: string;
  allowManualCodes?: boolean;
  disabled?: boolean;
}

export function XeroAccountSelect({
  accounts,
  classFilter = "REVENUE",
  ...rest
}: XeroAccountSelectProps) {
  const options = useMemo(
    () =>
      accounts
        .filter(
          (account) =>
            !classFilter ||
            account.class?.toUpperCase() === classFilter.toUpperCase(),
        )
        .map((account) => ({ code: account.code, name: account.name })),
    [accounts, classFilter],
  );
  return <XeroCodeSelect {...rest} options={options} noun="account" />;
}

interface XeroItemSelectProps {
  items: XeroItem[];
  value: string;
  onChange: (code: string) => void;
  emptyLabel: string;
  ariaLabel: string;
  allowManualCodes?: boolean;
  disabled?: boolean;
}

export function XeroItemSelect({ items, ...rest }: XeroItemSelectProps) {
  const options = useMemo(
    () => items.map((item) => ({ code: item.code, name: item.name })),
    [items],
  );
  return <XeroCodeSelect {...rest} options={options} noun="item" />;
}
