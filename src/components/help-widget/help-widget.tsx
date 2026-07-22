"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { CircleHelp, X } from "lucide-react";
import { usePathname } from "next/navigation";
import type { HelpQuestion, HelpSection } from "@/lib/contextual-help";
import type { HelpPageContent } from "@/lib/help/types";
import { HelpBrowseView } from "./help-browse-view";
import { HelpChatThread } from "./help-chat-thread";
import { HelpFreeTextInput } from "./help-free-text-input";
import { serializePageContext } from "./help-page-context";
import { useHelpWidgetState } from "./help-widget-context";
import { useHelpChat, type HelpChatSurface } from "./use-help-chat";

const GREETING = "Kia ora — need a hand with this page?";
const MAX_CHIPS = 8;

export type HelpWidgetSurface = "public" | "member" | "admin" | "finance";

export type HelpWidgetProps = {
  surface: HelpWidgetSurface;
  llmEnabled: boolean;
  resolveHelp: (pathname: string) => HelpPageContent;
  position?: "app" | "website";
  /**
   * Typed free-text fetch target. Undefined in this PR (epic #2094 C2) — the
   * free-text input never renders and no fetch is reachable while llmEnabled is
   * false. C4 supplies it and flips llmEnabled.
   */
  chatEndpoint?: string;
};

/**
 * Hide the launcher while the analytics cookie banner occupies the same bottom
 * corner (website surface only). `AnalyticsConsent` stamps
 * `data-analytics-consent-banner="visible"` on the document element and fires an
 * `analytics-consent-visibility` event, so this is a deterministic, reactive
 * read of the same signal the banner drives — no duplicated storage logic.
 */
function useConsentBannerVisible(active: boolean): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const read = () =>
      document.documentElement.getAttribute("data-analytics-consent-banner") ===
      "visible";
    setVisible(read());
    const onVisibility = (event: Event) => {
      const detail = (event as CustomEvent<{ visible?: boolean }>).detail;
      setVisible(detail?.visible ?? read());
    };
    window.addEventListener("analytics-consent-visibility", onVisibility);
    return () =>
      window.removeEventListener("analytics-consent-visibility", onVisibility);
  }, [active]);

  return active && visible;
}

function orderChips(
  questions: HelpQuestion[],
  hintGroup: string | null,
): HelpQuestion[] {
  const ordered = hintGroup
    ? [...questions].sort(
        (a, b) =>
          Number(b.group === hintGroup) - Number(a.group === hintGroup),
      )
    : questions;
  return ordered.slice(0, MAX_CHIPS);
}

export function HelpWidget({
  surface,
  llmEnabled,
  resolveHelp,
  position = "app",
  chatEndpoint,
}: HelpWidgetProps) {
  const pathname = usePathname() ?? "/";
  const content = resolveHelp(pathname);
  const { extras, hintGroup } = useHelpWidgetState();
  const chat = useHelpChat({ llmEnabled, chatEndpoint });

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"ask" | "guide">("ask");
  const [viewportOffset, setViewportOffset] = useState(0);

  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const wasOpen = useRef(false);
  const headingId = useId();

  const consentBannerVisible = useConsentBannerVisible(surface === "public");

  // Route change: reset to the chip (Ask) view, but keep the transcript.
  useEffect(() => {
    setTab("ask");
  }, [pathname]);

  // Focus moves into the panel on open and returns to the launcher on close.
  useEffect(() => {
    if (open && !wasOpen.current) {
      headingRef.current?.focus();
    } else if (!open && wasOpen.current) {
      launcherRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  // iOS keyboard: lift the panel by the on-screen keyboard's height so a focused
  // control stays visible. The free-text input ships in C4; the mechanism is
  // wired now (guarded on visualViewport support).
  useEffect(() => {
    if (!open || typeof window === "undefined" || !window.visualViewport) {
      setViewportOffset(0);
      return;
    }
    const viewport = window.visualViewport;
    const update = () => {
      const offset = Math.max(
        0,
        window.innerHeight - viewport.height - viewport.offsetTop,
      );
      setViewportOffset(offset);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [open]);

  // Plain handlers — the React Compiler memoises these; a manual useCallback
  // trips its "could not be preserved" guard (house style, cf. ReportIssueWidget).
  const close = () => setOpen(false);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };

  // Keep a focused text control centred above the keyboard (C4 input).
  const handleBodyFocus = (event: FocusEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (typeof target.matches === "function" && target.matches("input, textarea")) {
      target.scrollIntoView?.({ block: "center" });
    }
  };

  const chips = orderChips(
    [...(extras.questions ?? []), ...(content.questions ?? [])],
    hintGroup,
  );
  const extraSections: HelpSection[] = extras.sections ?? [];
  const footerNote =
    surface === "public" ? "Members: sign in for more help." : undefined;

  // The paid AI free-text box renders only on an authenticated surface when the
  // LLM is available and a typed endpoint is supplied. The public surface never
  // reaches it (llmEnabled is a hardcoded false there).
  const showFreeText =
    llmEnabled && Boolean(chatEndpoint) && surface !== "public";

  // Plain handler — the React Compiler memoises it; a manual useCallback trips
  // its "could not be preserved" guard (house style).
  const handleSend = (text: string) => {
    void chat.sendFreeText(text, {
      pathname,
      surface: surface as HelpChatSurface,
      pageContext: serializePageContext(extras),
    });
  };

  const launcherWrapperClass =
    position === "website"
      ? "fixed bottom-6 right-5 z-50 sm:right-6 print:hidden"
      : "fixed bottom-20 left-5 z-50 sm:bottom-6 sm:right-6 sm:left-auto print:hidden";

  return (
    <>
      {consentBannerVisible ? null : (
        <div className={launcherWrapperClass} data-report-issue-ignore="true">
          <button
            ref={launcherRef}
            type="button"
            data-testid="help-widget-launcher"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-haspopup="dialog"
            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg transition-shadow hover:shadow-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <CircleHelp aria-hidden="true" className="h-4 w-4" />
            Help
          </button>
        </div>
      )}

      {open ? (
        <div
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          data-testid="help-widget-panel"
          data-report-issue-ignore="true"
          onKeyDown={handleKeyDown}
          style={viewportOffset > 0 ? { bottom: viewportOffset } : undefined}
          className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-xl border border-border bg-card text-foreground shadow-lg sm:inset-x-auto sm:bottom-20 sm:right-6 sm:w-[24rem] sm:max-h-[70vh] sm:rounded-xl print:hidden"
        >
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2
              id={headingId}
              ref={headingRef}
              tabIndex={-1}
              className="text-sm font-semibold text-foreground focus:outline-none"
            >
              Help
            </h2>
            <button
              type="button"
              onClick={close}
              aria-label="Close help"
              className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          </header>

          <div className="flex gap-1 border-b border-border px-2 py-2">
            <button
              type="button"
              aria-pressed={tab === "ask"}
              onClick={() => setTab("ask")}
              className={`rounded-md px-3 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                tab === "ask"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Ask
            </button>
            <button
              type="button"
              aria-pressed={tab === "guide"}
              onClick={() => setTab("guide")}
              className={`rounded-md px-3 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                tab === "guide"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Page guide
            </button>
          </div>

          <div
            onFocusCapture={handleBodyFocus}
            className="flex-1 overflow-y-auto overscroll-contain px-4 py-4"
          >
            {tab === "ask" ? (
              <div className="flex flex-col gap-4">
                <HelpChatThread
                  greeting={GREETING}
                  messages={chat.messages}
                  questions={chips}
                  onAsk={chat.askCurated}
                  footerNote={footerNote}
                  capReached={chat.capReached}
                  pending={chat.pending}
                />
                {showFreeText ? (
                  <HelpFreeTextInput
                    onSend={handleSend}
                    pending={chat.pending}
                    capReached={chat.capReached}
                    disabledReason={chat.disabledReason}
                    onReset={chat.reset}
                  />
                ) : null}
              </div>
            ) : (
              <HelpBrowseView content={content} extraSections={extraSections} />
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
