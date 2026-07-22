"use client";

import { useCallback, useRef, useState } from "react";
import type { HelpQuestion } from "@/lib/contextual-help";

/**
 * Help-widget conversation state. Two ways to add a turn:
 *  - `askCurated(question)` — appends the question and its distilled answer
 *    instantly from the trusted corpus. This is the ONLY path that runs while
 *    the LLM is disabled.
 *  - `sendFreeText(text)` — the free-text path. It is DEAD CODE behind
 *    `llmEnabled` in this PR (epic #2094 C2): the free-text input does not
 *    render while `llmEnabled` is false, and no `chatEndpoint` is supplied, so
 *    the guard below returns before any fetch. C4 passes the real endpoint and
 *    flips `llmEnabled`, at which point this branch goes live unchanged — this
 *    PR deliberately hardcodes no route string.
 */

export type HelpChatRole = "user" | "assistant";

export type HelpChatMessage = {
  id: string;
  role: HelpChatRole;
  text: string;
  /** Set on answers that came verbatim from the templated corpus. */
  fromGuide?: boolean;
  link?: { href: string; label: string };
};

/** Free-text turns allowed before the widget suggests browsing the guide. */
export const FREE_TEXT_TURN_CAP = 10;

const FALLBACK_ANSWER =
  "Sorry — I could not answer that just now. Try the Page guide tab, or contact the club office.";

export type UseHelpChatOptions = {
  llmEnabled: boolean;
  /** Typed fetch target for the free-text path; supplied by C4, never here. */
  chatEndpoint?: string;
};

export type UseHelpChat = {
  messages: HelpChatMessage[];
  askCurated: (question: HelpQuestion) => void;
  sendFreeText: (text: string) => Promise<void>;
  reset: () => void;
  pending: boolean;
  capReached: boolean;
  freeTextCount: number;
};

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `help-msg-${idCounter}`;
}

export function useHelpChat({
  llmEnabled,
  chatEndpoint,
}: UseHelpChatOptions): UseHelpChat {
  const [messages, setMessages] = useState<HelpChatMessage[]>([]);
  const [freeTextCount, setFreeTextCount] = useState(0);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const capReached = freeTextCount >= FREE_TEXT_TURN_CAP;

  const askCurated = useCallback((question: HelpQuestion) => {
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "user", text: question.q },
      {
        id: nextId(),
        role: "assistant",
        text: question.a,
        fromGuide: true,
        link: question.link,
      },
    ]);
  }, []);

  const sendFreeText = useCallback(
    async (text: string) => {
      // Dead behind llmEnabled: unreachable while the input is not rendered and
      // no endpoint is configured. No fetch is reachable in this PR.
      if (!llmEnabled || !chatEndpoint) {
        return;
      }
      const trimmed = text.trim();
      if (!trimmed || capReached || pendingRef.current) {
        return;
      }

      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", text: trimmed },
      ]);
      setFreeTextCount((count) => count + 1);
      pendingRef.current = true;
      setPending(true);

      try {
        const response = await fetch(chatEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed }),
        });
        const data = (await response.json().catch(() => null)) as {
          answer?: unknown;
        } | null;
        const answer =
          typeof data?.answer === "string" ? data.answer : FALLBACK_ANSWER;
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", text: answer },
        ]);
      } catch {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", text: FALLBACK_ANSWER },
        ]);
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [llmEnabled, chatEndpoint, capReached],
  );

  const reset = useCallback(() => {
    setMessages([]);
    setFreeTextCount(0);
  }, []);

  return {
    messages,
    askCurated,
    sendFreeText,
    reset,
    pending,
    capReached,
    freeTextCount,
  };
}
