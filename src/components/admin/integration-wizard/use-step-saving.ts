"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { WizardStepHelpers } from "./types";

/**
 * #4410: a wizard step's "save in flight" flag, mirrored to the shell.
 *
 * Use it in place of a local `useState(false)` for any step that writes: the
 * step reads `saving` for its own button, and every `setSaving(...)` also
 * tells the shell (`helpers.reportSaving`), which holds Continue and the
 * stepper until the save settles. One setter for both, so the step's spinner
 * and the shell's lock can never disagree, however many early returns the
 * save has. A step that unmounts mid-save releases the lock.
 */
export function useStepSaving(
  helpers: Pick<WizardStepHelpers, "reportSaving">,
): [boolean, (saving: boolean) => void] {
  const [saving, setSavingState] = useState(false);
  // The shell hands a fresh helpers object every render; keep the latest
  // reporter without re-running the unmount release on each render.
  const { reportSaving } = helpers;
  const reportRef = useRef(reportSaving);
  useEffect(() => {
    reportRef.current = reportSaving;
  }, [reportSaving]);

  // Whether this copy of the step holds the shell's lock, so an unmount
  // releases only a lock it took.
  const holdsLockRef = useRef(false);
  const setSaving = useCallback((next: boolean) => {
    setSavingState(next);
    holdsLockRef.current = next;
    reportRef.current(next);
  }, []);

  useEffect(
    () => () => {
      if (holdsLockRef.current) reportRef.current(false);
    },
    [],
  );

  return [saving, setSaving];
}
