"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { SendHorizontal } from "lucide-react";
import type { ChatDisabledReason } from "./use-help-chat";

/**
 * The paid AI free-text ask box (epic #2094 C4). Renders under the curated chips
 * whenever the LLM is available. A persistent disclaimer sits above the input
 * whenever the box renders (EXACT pinned wording — do not alter).
 *
 * States:
 *  - cap reached: the input is replaced with a limit notice + "Start new chat".
 *  - budget disabled (session): the input is replaced with a static notice.
 *  - otherwise: disclaimer + textarea + send button (disabled while pending).
 */

export const AI_DISCLAIMER =
  "AI answers can be wrong — check the page itself for anything important. Your question is sent to Anthropic (US); don't include personal details.";
export const CAP_MESSAGE =
  "That's the limit for one conversation. Curated page help still works.";
export const BUDGET_DISABLED_NOTICE =
  "The AI assistant is unavailable for the rest of the month (spending limit reached). Curated page help still works.";

export function HelpFreeTextInput({
  onSend,
  pending,
  capReached,
  disabledReason,
  onReset,
}: {
  onSend: (text: string) => void;
  pending: boolean;
  capReached: boolean;
  disabledReason: ChatDisabledReason | null;
  onReset: () => void;
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const prevCapReached = useRef(capReached);

  // After "Start new chat" (onReset) transitions the widget out of the cap
  // state, the input re-mounts; move focus to it so the member can keep typing.
  useEffect(() => {
    if (prevCapReached.current && !capReached) {
      textareaRef.current?.focus();
    }
    prevCapReached.current = capReached;
  }, [capReached]);

  if (capReached) {
    return (
      <div className="space-y-3 border-t border-border pt-3">
        <p className="text-sm text-muted-foreground">{CAP_MESSAGE}</p>
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Start new chat
        </button>
      </div>
    );
  }

  if (disabledReason === "budget") {
    return (
      <p className="border-t border-border pt-3 text-sm text-muted-foreground">
        {BUDGET_DISABLED_NOTICE}
      </p>
    );
  }

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || pending) return;
    onSend(trimmed);
    setValue("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <p
        id="help-ai-disclaimer"
        className="text-xs leading-5 text-muted-foreground"
      >
        {AI_DISCLAIMER}
      </p>
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          aria-label="Ask about this page"
          aria-describedby="help-ai-disclaimer"
          placeholder="Ask about this page…"
          rows={2}
          value={value}
          maxLength={1000}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          className="min-h-[2.75rem] flex-1 resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm leading-6 text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />
        <button
          type="button"
          onClick={submit}
          disabled={pending || value.trim().length === 0}
          aria-label="Send question"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          <SendHorizontal aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
