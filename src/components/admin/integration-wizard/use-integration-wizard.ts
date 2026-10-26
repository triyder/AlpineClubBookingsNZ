"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { wizardProgressPath } from "@/lib/integration-wizard-progress-routes";

/**
 * Cursor persistence for the reusable integration wizard shell (#2080).
 *
 * Loads the resume cursor once from the wizard-progress API and exposes a
 * `persist` that saves the current step + acknowledged optional steps. The
 * persisted cursor is a RESUME hint only — the shell always re-derives step
 * verification from live server truth, so a stale cursor can never skip a gate.
 */

// A write that never settles would hold back every later one (#4014 review).
const CURSOR_WRITE_TIMEOUT_MS = 10_000;

interface WizardProgressResponse {
  progress?: {
    currentStepId?: string;
    completedStepIds?: string[];
  } | null;
}

export interface WizardCursor {
  /** True once the persisted cursor has been loaded (or failed, fail-open). */
  loaded: boolean;
  /** Persisted resume step id, or null when nothing was saved yet. */
  persistedStepId: string | null;
  /** Acknowledged (skipped) optional step ids. */
  acknowledged: string[];
  /**
   * Save the cursor. Best-effort; a failure never blocks the wizard. Writes go
   * out one at a time, newest waiting write next, so they reach the server in
   * the order they were made (#4014).
   */
  persist: (currentStepId: string, completedStepIds: string[]) => void;
}

interface CursorWrite {
  currentStepId: string;
  completedStepIds: string[];
}

export function useWizardCursor(wizardId: string): WizardCursor {
  const [loaded, setLoaded] = useState(false);
  const [persistedStepId, setPersistedStepId] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  // Avoid a redundant POST when nothing actually changed.
  const lastSaved = useRef<string>("");
  // At most ONE cursor write on the wire at a time, latest wins (#4014).
  //
  // Two independent fetches carry no ordering guarantee: the browser can hold
  // both in its per-host socket queue (six sockets, easily saturated by the
  // admin shell's route prefetches) and the server can commit them in either
  // order. The stored row is last-commit-wins, so an operator who moved
  // create-app -> credentials -> connect in quick succession could be resumed
  // on `credentials` after the OAuth round-trip, because the OLDER write landed
  // second — captured in E2E run 37830486574, where the "credentials" write
  // committed after the "connect" one on both retries.
  //
  // So a write made while another is in flight waits, and only the newest
  // waiting write is sent: the server then sees writes in the order the
  // operator made them, and an older position can never overwrite a newer one.
  const writeInFlight = useRef(false);
  const queuedWrite = useRef<CursorWrite | null>(null);

  // Every write is keepalive (#4014 review): a write in flight when the page is
  // left for the OAuth round-trip must still reach the server, not be
  // cancelled with the old document. The body is tiny, far under the limit.
  const postWrite = useCallback(
    (write: CursorWrite, signal?: AbortSignal) =>
      fetch(wizardProgressPath(wizardId), {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wizardId, ...write }),
      }),
    [wizardId],
  );

  const sendWrite = useCallback(
    (first: CursorWrite) => {
      const send = (write: CursorWrite) => {
        writeInFlight.current = true;
        void postWrite(write, AbortSignal.timeout(CURSOR_WRITE_TIMEOUT_MS))
          .catch(() => {
            // Best-effort persistence; the in-memory cursor still drives the flow.
          })
          .finally(() => {
            // Settled either way, so the next write may go. A failed write
            // still releases the queue: dropping the newest position because
            // an older one failed would be the same defect by another route.
            writeInFlight.current = false;
            const next = queuedWrite.current;
            queuedWrite.current = null;
            if (next) send(next);
          });
      };
      send(first);
    },
    [postWrite],
  );

  // Leaving the page with a write still waiting (the Connect step hands the
  // whole page to the OAuth round-trip): the write in flight will never settle
  // in this document to release it, so send the waiting one now, as a
  // keepalive request that outlives the page. Without this the newest position
  // would be lost and the wizard would resume one step behind. Limit: that send
  // and the one in flight are then both on the wire, so on this path alone the
  // server could commit them out of order; the in-flight one usually settles
  // before the redirect completes. A bfcache restore does not re-send it.
  useEffect(() => {
    const flushOnLeave = () => {
      const waiting = queuedWrite.current;
      if (!waiting) return;
      queuedWrite.current = null;
      void postWrite(waiting).catch(() => {
        // Best-effort, as every cursor write is.
      });
    };
    window.addEventListener("pagehide", flushOnLeave);
    return () => window.removeEventListener("pagehide", flushOnLeave);
  }, [postWrite]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch(
          `${wizardProgressPath(wizardId)}?wizardId=${encodeURIComponent(wizardId)}`,
          { credentials: "same-origin" },
        );
        if (!res.ok) throw new Error("load failed");
        const data = (await res.json()) as WizardProgressResponse;
        if (!active) return;
        setPersistedStepId(data.progress?.currentStepId ?? null);
        setAcknowledged(data.progress?.completedStepIds ?? []);
      } catch {
        // Fail-open: a missing/failed cursor just means "start at the gate".
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [wizardId]);

  const persist = useCallback(
    (currentStepId: string, completedStepIds: string[]) => {
      const key = `${currentStepId}|${[...completedStepIds].sort().join(",")}`;
      if (key === lastSaved.current) return;
      lastSaved.current = key;
      setAcknowledged(completedStepIds);
      const write = { currentStepId, completedStepIds };
      if (writeInFlight.current) {
        // Replaces any write already waiting: only the newest position matters.
        queuedWrite.current = write;
        return;
      }
      sendWrite(write);
    },
    [sendWrite],
  );

  return { loaded, persistedStepId, acknowledged, persist };
}
