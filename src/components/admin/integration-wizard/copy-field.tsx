"use client";

import { useCallback, useId, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Shared copy-paste field for the guided-provider setup wizards (#2080).
 *
 * PROVIDER-AGNOSTIC by construction: it takes a label and a value and nothing
 * else provider-specific, so Xero (this issue), Stripe (C4) and Google (C5)
 * reuse the exact same component. No ad-hoc `navigator.clipboard` calls live in
 * any wizard step — they all go through here.
 *
 * Accessibility + robustness:
 *  - the value is always VISIBLE (operators verify what they are pasting), and
 *    its accessible name is the field label via `aria-labelledby` (a `<label
 *    htmlFor>` cannot target a `<code>`, which is not a labelable element);
 *  - a polite `aria-live` region announces "Copied" / "Press Ctrl+C to copy"
 *    without stealing focus, AND the same instruction is shown VISIBLY (the
 *    button label switches to "Press Ctrl+C") so a sighted mouse user — who
 *    never hears the live region — also learns what to do;
 *  - the Clipboard API is only available in a SECURE CONTEXT. Many club LAN
 *    deployments serve plain HTTP over a private address (not localhost), where
 *    `navigator.clipboard` is undefined. Rather than a dead button, we fall back
 *    to selecting the text so the operator can Ctrl+C — and both the button
 *    label and a visible hint say exactly that;
 *  - when there is no value yet (e.g. `NEXTAUTH_URL` is unset, so the redirect
 *    URI cannot be derived), pass `emptyHint`: the field renders a muted
 *    placeholder and DISABLES copy, so "Copy" can never copy an instruction
 *    string as though it were the real value.
 */
export function CopyField({
  label,
  value,
  description,
  className,
  monospace = true,
  emptyHint,
}: {
  label: string;
  value: string;
  description?: string;
  className?: string;
  /** Render the value in a monospace face (default true — most values are ids/URLs). */
  monospace?: boolean;
  /**
   * Shown (muted) in place of the value when `value` is empty, with copy
   * disabled. Use for a not-yet-available value so the copy button never yields
   * an instruction string.
   */
  emptyHint?: string;
}) {
  const labelId = useId();
  const valueId = useId();
  const statusId = useId();
  const valueRef = useRef<HTMLElement | null>(null);
  const isEmpty = value.trim() === "";
  const [copied, setCopied] = useState(false);
  // Distinct from `copied`: the fallback path could not write the clipboard, so
  // the announcement tells the operator to copy the (now-selected) text.
  const [selectOnly, setSelectOnly] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleReset = useCallback(() => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      setCopied(false);
      setSelectOnly(false);
    }, 2500);
  }, []);

  const selectValueText = useCallback(() => {
    const node = valueRef.current;
    if (!node || typeof window === "undefined") return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  const handleCopy = useCallback(async () => {
    // Secure-context guard: navigator.clipboard is undefined on plain-HTTP LAN.
    const clipboard =
      typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (clipboard?.writeText) {
      try {
        await clipboard.writeText(value);
        setCopied(true);
        setSelectOnly(false);
        scheduleReset();
        return;
      } catch {
        // Fall through to the select-on-focus fallback below.
      }
    }
    // Fallback: select the text so the operator can press Ctrl/Cmd+C.
    selectValueText();
    setCopied(false);
    setSelectOnly(true);
    scheduleReset();
  }, [value, scheduleReset, selectValueText]);

  const buttonLabel = copied ? "Copied" : selectOnly ? "Press Ctrl+C" : "Copy";

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center justify-between gap-2">
        {/* A plain span, not a <label htmlFor>: the value is a <code>, which is
            not a labelable element, so the association is via aria-labelledby. */}
        <span id={labelId} className="text-sm font-medium text-foreground">
          {label}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleCopy()}
          aria-describedby={statusId}
          disabled={isEmpty}
        >
          {copied ? (
            <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          ) : (
            <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          )}
          {buttonLabel}
        </Button>
      </div>
      {isEmpty ? (
        <p
          id={valueId}
          className="block w-full rounded-md border border-dashed border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
        >
          {emptyHint ?? "Not set"}
        </p>
      ) : (
        <code
          id={valueId}
          ref={valueRef}
          // Named by its label (aria-labelledby) since a <code> takes no <label>.
          aria-labelledby={labelId}
          // Focusable + select-on-focus so a keyboard user (and the fallback) can
          // reach and grab the value even without a working Clipboard API.
          tabIndex={0}
          onFocus={selectValueText}
          className={cn(
            "block w-full overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring",
            monospace && "font-mono",
          )}
        >
          {value}
        </code>
      )}
      {description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}
      {/* Visible fallback hint for a sighted mouse user, who never hears the
          live region: shown only when the clipboard write was unavailable. */}
      {selectOnly ? (
        <p className="text-xs text-muted-foreground">
          Selected — press Ctrl+C (or Cmd+C on a Mac) to copy.
        </p>
      ) : null}
      {/* Polite live region — announces the copy outcome without moving focus. */}
      <span id={statusId} aria-live="polite" className="sr-only">
        {copied
          ? "Copied to clipboard"
          : selectOnly
            ? "Selected. Press Ctrl+C or Cmd+C to copy."
            : ""}
      </span>
    </div>
  );
}
