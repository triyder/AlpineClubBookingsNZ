"use client";

import { useEffect, useRef } from "react";
import { BookOpen } from "lucide-react";
import type { HelpQuestion } from "@/lib/contextual-help";
import { TRUNCATED_NOTE, type HelpChatMessage } from "./use-help-chat";

/**
 * The "Ask" view: a greeting, the running transcript, and a block of curated
 * question chips. Templated answers carry a "From the help guide" tag. The
 * transcript is a polite live region so a newly appended answer is announced.
 */
export function HelpChatThread({
  greeting,
  messages,
  questions,
  onAsk,
  footerNote,
  capReached,
  pending,
}: {
  greeting: string;
  messages: HelpChatMessage[];
  questions: HelpQuestion[];
  onAsk: (question: HelpQuestion) => void;
  footerNote?: string;
  capReached?: boolean;
  /** A free-text answer is in flight — show the typing indicator. */
  pending?: boolean;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // `scrollIntoView` is unimplemented under jsdom; optional-call it.
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length, pending]);

  return (
    <div className="flex flex-col gap-4">
      <div
        role="log"
        aria-live="polite"
        aria-label="Help conversation"
        className="flex flex-col gap-3"
      >
        <p className="text-sm leading-6 text-muted-foreground">{greeting}</p>

        {messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm leading-6 text-primary-foreground">
                {message.text}
              </div>
            </div>
          ) : (
            <div key={message.id} className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm leading-6 text-foreground">
                <p className="whitespace-pre-wrap">{message.text}</p>
                {message.link ? (
                  <a
                    href={message.link.href}
                    className="mt-1 inline-block font-medium text-foreground underline underline-offset-4 hover:text-primary"
                  >
                    {message.link.label}
                  </a>
                ) : null}
                {message.fromGuide ? (
                  <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <BookOpen aria-hidden="true" className="h-3 w-3" />
                    From the help guide
                  </p>
                ) : null}
                {message.truncated ? (
                  <p className="mt-1 text-xs italic text-muted-foreground">
                    {TRUNCATED_NOTE}
                  </p>
                ) : null}
              </div>
            </div>
          ),
        )}
        {pending ? (
          <div className="flex justify-start">
            <div
              className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm leading-6 text-muted-foreground"
              data-testid="help-typing-indicator"
            >
              <span className="sr-only">The assistant is typing…</span>
              <span aria-hidden="true" className="inline-flex gap-1">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground [animation-delay:300ms]" />
              </span>
            </div>
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      {questions.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Common questions
          </h3>
          <ul className="flex flex-col gap-2">
            {questions.map((question) => (
              <li key={question.q}>
                <button
                  type="button"
                  onClick={() => onAsk(question)}
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-left text-sm leading-6 text-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {question.q}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div aria-live="polite" className="sr-only">
        {capReached
          ? "You have reached the limit for one conversation. Start a new chat to keep asking, or use the curated questions."
          : ""}
      </div>

      {footerNote ? (
        <p className="border-t border-border pt-3 text-xs text-muted-foreground">
          {footerNote}
        </p>
      ) : null}
    </div>
  );
}
