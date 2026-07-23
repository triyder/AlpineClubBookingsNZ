"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { HelpQuestion, HelpSection } from "@/lib/contextual-help";

/**
 * Cross-tree channel that lets a page register EXTRA help — sections and curated
 * questions — into the global help widget mounted by the layout, plus a per-page
 * HINT that reorders the widget's chip suggestions (e.g. the booking wizard step
 * a member is on). This is how the booking-detail page re-surfaces the four
 * blocks the retired `BookingHelpDialog` carried (epic #2094 C2), without the
 * widget having to know about any specific page.
 *
 * Every hook here is no-op-safe when no provider is mounted, so a page leaf can
 * register extras unconditionally and simply do nothing on surfaces (public /
 * login) that have no widget.
 */

export type HelpWidgetExtras = {
  sections?: HelpSection[];
  questions?: HelpQuestion[];
};

type Registration = { id: number; extras: HelpWidgetExtras };

type HelpWidgetContextValue = {
  /** Merged extras from every live registration (registration order). */
  extras: HelpWidgetExtras;
  /** The active page hint group, or null. */
  hintGroup: string | null;
  registerExtras: (extras: HelpWidgetExtras) => number;
  deregisterExtras: (id: number) => void;
  setHint: (group: string | null) => void;
};

const HelpWidgetContext = createContext<HelpWidgetContextValue | null>(null);

function mergeRegistrations(registrations: Registration[]): HelpWidgetExtras {
  const sections: HelpSection[] = [];
  const questions: HelpQuestion[] = [];
  for (const { extras } of registrations) {
    if (extras.sections) sections.push(...extras.sections);
    if (extras.questions) questions.push(...extras.questions);
  }
  return { sections, questions };
}

export function HelpWidgetProvider({ children }: { children: ReactNode }) {
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [hintGroup, setHintGroup] = useState<string | null>(null);
  const nextId = useRef(0);

  const registerExtras = useCallback((extras: HelpWidgetExtras) => {
    const id = (nextId.current += 1);
    setRegistrations((prev) => [...prev, { id, extras }]);
    return id;
  }, []);

  const deregisterExtras = useCallback((id: number) => {
    setRegistrations((prev) => prev.filter((entry) => entry.id !== id));
  }, []);

  const extras = useMemo(
    () => mergeRegistrations(registrations),
    [registrations],
  );

  const value = useMemo<HelpWidgetContextValue>(
    () => ({
      extras,
      hintGroup,
      registerExtras,
      deregisterExtras,
      setHint: setHintGroup,
    }),
    [extras, hintGroup, registerExtras, deregisterExtras],
  );

  return (
    <HelpWidgetContext.Provider value={value}>
      {children}
    </HelpWidgetContext.Provider>
  );
}

/**
 * Read the widget's merged extras and active hint. Returns inert defaults when
 * no provider is mounted, so the widget renders fine on a bare surface.
 */
export function useHelpWidgetState(): {
  extras: HelpWidgetExtras;
  hintGroup: string | null;
} {
  const ctx = useContext(HelpWidgetContext);
  return {
    extras: ctx?.extras ?? {},
    hintGroup: ctx?.hintGroup ?? null,
  };
}

/**
 * Register page-scoped extras into the widget for as long as the calling
 * component is mounted; deregisters on unmount. No-op without a provider. The
 * extras are re-registered whenever their content changes.
 */
export function useHelpWidgetExtras(extras: HelpWidgetExtras): void {
  const ctx = useContext(HelpWidgetContext);
  const registerExtras = ctx?.registerExtras;
  const deregisterExtras = ctx?.deregisterExtras;
  // Serialise so a new object literal with identical content does not thrash the
  // registration on every render.
  const key = JSON.stringify(extras);

  useEffect(() => {
    if (!registerExtras || !deregisterExtras) {
      return;
    }
    const id = registerExtras(extras);
    return () => deregisterExtras(id);
    // `key` captures the meaningful identity of `extras`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerExtras, deregisterExtras, key]);
}

/**
 * Publish a page hint (e.g. the current booking-wizard step) that reorders the
 * widget's chips. Clears on unmount. No-op without a provider.
 */
export function useHelpWidgetHint(hint: { group?: string | null }): void {
  const ctx = useContext(HelpWidgetContext);
  const setHint = ctx?.setHint;
  const group = hint.group ?? null;

  useEffect(() => {
    if (!setHint) {
      return;
    }
    setHint(group);
    return () => setHint(null);
  }, [setHint, group]);
}
