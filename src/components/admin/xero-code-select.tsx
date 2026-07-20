"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
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
  /** DOM id for the trigger button, so a row <Label htmlFor> can associate. */
  id?: string;
  /** Noun used in the search placeholder + manual-add copy ("account"/"item"). */
  noun: string;
  /**
   * Allow choosing a free-typed code not present in `options` — the Xero
   * disconnected fallback, mirroring XeroAccountMultiSelect.allowManualCodes.
   * Manual entry is ALSO enabled automatically when the effective option list is
   * empty (e.g. a loaded COA with zero REVENUE accounts), so the editor never
   * dead-ends with no way to enter a code (#2068, F2).
   */
  allowManualCodes?: boolean;
  /**
   * Optional "show all" toggle rendered above the option list — the account
   * picker uses it to let an operator ignore the REVENUE class filter and pick
   * (or re-select) a non-revenue/archived code (#2068, F3). Mirrors the toggle
   * in XeroAccountMultiSelect.
   */
  filterToggle?: { label: string; active: boolean; onToggle: (next: boolean) => void };
  disabled?: boolean;
}

export function XeroCodeSelect({
  value,
  onChange,
  options,
  emptyLabel,
  ariaLabel,
  id,
  noun,
  allowManualCodes = false,
  filterToggle,
  disabled = false,
}: XeroCodeSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();

  const optionByCode = useMemo(() => {
    const map = new Map<string, XeroCodeOption>();
    for (const option of options) map.set(normalizeCode(option.code), option);
    return map;
  }, [options]);

  // Return focus to the trigger when the popup closes via selection or Escape,
  // so keyboard users are not stranded (#2068, U2). Click-outside intentionally
  // leaves focus where the user clicked.
  function closeAndRefocus() {
    setOpen(false);
    triggerRef.current?.focus();
  }

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
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
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

  // Manual entry is offered when the caller opts in (disconnected Xero) OR when
  // the effective option list is empty, so a filtered-to-nothing picker (e.g. no
  // REVENUE accounts) still lets the operator type a code (#2068, F2).
  const effectiveAllowManual = allowManualCodes || options.length === 0;
  const manualQueryCode = normalizeCode(query);
  const canAddManual =
    effectiveAllowManual &&
    manualQueryCode.length > 0 &&
    !optionByCode.has(manualQueryCode) &&
    manualQueryCode !== normalizedValue;

  function choose(code: string) {
    onChange(normalizeCode(code));
    setQuery("");
    closeAndRefocus();
  }

  return (
    <div className="relative" ref={containerRef}>
      <Button
        ref={triggerRef}
        id={id}
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        className="w-full justify-between font-normal"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span
          className={cn("truncate", !normalizedValue && "text-slate-500")}
          title={triggerLabel}
        >
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
            {filterToggle ? (
              <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={filterToggle.active}
                  onChange={(event) => filterToggle.onToggle(event.target.checked)}
                />
                {filterToggle.label}
              </label>
            ) : null}
          </div>
          <ul role="listbox" id={listboxId} className="max-h-64 overflow-y-auto py-1">
            {/* Reset to the resolved default (empty stored code). */}
            <li role="option" aria-selected={!normalizedValue}>
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
            </li>
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-slate-500">
                {options.length === 0
                  ? `No Xero ${noun}s available.`
                  : `No ${noun}s match your search.`}
              </li>
            ) : (
              filtered.map((option) => {
                const normalized = normalizeCode(option.code);
                const checked = normalized === normalizedValue;
                return (
                  <li role="option" aria-selected={checked} key={normalized}>
                    <button
                      type="button"
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
                  </li>
                );
              })
            )}
            {canAddManual ? (
              <li role="option" aria-selected={false}>
                <button
                  type="button"
                  onClick={() => choose(manualQueryCode)}
                  className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                >
                  <Plus className="h-4 w-4" />
                  Use code “{manualQueryCode}”
                </button>
              </li>
            ) : null}
          </ul>
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
  id?: string;
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
  // "Show all accounts" ignores the class filter so an operator can pick (or
  // re-select) a non-revenue/archived code (#2068, F3), mirroring the toggle in
  // XeroAccountMultiSelect. The default view stays REVENUE-only.
  const [showAll, setShowAll] = useState(false);
  const options = useMemo(
    () =>
      accounts
        .filter(
          (account) =>
            showAll ||
            !classFilter ||
            account.class?.toUpperCase() === classFilter.toUpperCase(),
        )
        .map((account) => ({ code: account.code, name: account.name })),
    [accounts, classFilter, showAll],
  );
  const filterToggle = classFilter
    ? {
        label: `Show all accounts (ignore ${classFilter.toLowerCase()} filter)`,
        active: showAll,
        onToggle: setShowAll,
      }
    : undefined;
  return (
    <XeroCodeSelect {...rest} options={options} noun="account" filterToggle={filterToggle} />
  );
}

interface XeroItemSelectProps {
  items: XeroItem[];
  value: string;
  onChange: (code: string) => void;
  emptyLabel: string;
  ariaLabel: string;
  id?: string;
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
