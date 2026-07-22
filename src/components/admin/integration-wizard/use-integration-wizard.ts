"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Cursor persistence for the reusable integration wizard shell (#2080).
 *
 * Loads the resume cursor once from the wizard-progress API and exposes a
 * `persist` that saves the current step + acknowledged optional steps. The
 * persisted cursor is a RESUME hint only — the shell always re-derives step
 * verification from live server truth, so a stale cursor can never skip a gate.
 */

const ENDPOINT = "/api/admin/integrations/wizard-progress";

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
  /** Save the cursor. Best-effort; a failure never blocks the wizard. */
  persist: (currentStepId: string, completedStepIds: string[]) => void;
}

export function useWizardCursor(wizardId: string): WizardCursor {
  const [loaded, setLoaded] = useState(false);
  const [persistedStepId, setPersistedStepId] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  // Avoid a redundant POST when nothing actually changed.
  const lastSaved = useRef<string>("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch(
          `${ENDPOINT}?wizardId=${encodeURIComponent(wizardId)}`,
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
      void fetch(ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wizardId, currentStepId, completedStepIds }),
      }).catch(() => {
        // Best-effort persistence; the in-memory cursor still drives the flow.
      });
    },
    [wizardId],
  );

  return { loaded, persistedStepId, acknowledged, persist };
}
