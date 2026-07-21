"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { AdminViewOnlySectionBanner } from "@/components/admin/view-only-action";
import { useWizardCursor } from "./use-integration-wizard";
import type { IntegrationWizardProps, WizardStepHelpers } from "./types";

/**
 * Reusable, PROVIDER-AGNOSTIC guided-setup wizard shell (#2080).
 *
 * Everything here is provider-neutral: the shell renders a stepper, gates
 * advance on each step's own `isVerified(context)`, resumes from a persisted
 * cursor, and frames every state with the view-only banner. Xero (this issue),
 * Stripe (C4) and Google (C5) are each just a `context` + `steps` config passed
 * in — there is deliberately no provider name, copy, or import in this file.
 *
 * Gating: a step is "passed" when it verifies (or is optional and
 * acknowledged). The furthest reachable step is the FIRST unpassed step, so the
 * operator can freely revisit completed steps but can never jump a gate — even
 * via a deep link or a stale persisted cursor.
 */
export function IntegrationWizard<Ctx>({
  wizardId,
  title,
  description,
  steps,
  context,
  contextLoading,
  onRefresh,
  canEdit,
  viewOnlyBanner: viewOnlyBannerText,
  initialStepId,
}: IntegrationWizardProps<Ctx>) {
  const cursor = useWizardCursor(wizardId);

  // Derived gating from live server truth (never from a persisted flag).
  const verifiedFlags = useMemo(
    () => steps.map((step) => step.isVerified(context)),
    [steps, context],
  );
  const acknowledgedSet = useMemo(
    () => new Set(cursor.acknowledged),
    [cursor.acknowledged],
  );
  const passedFlags = useMemo(
    () =>
      steps.map(
        (step, i) =>
          verifiedFlags[i] || (step.optional === true && acknowledgedSet.has(step.id)),
      ),
    [steps, verifiedFlags, acknowledgedSet],
  );
  const firstUnpassed = passedFlags.indexOf(false);
  const maxReachable = firstUnpassed === -1 ? steps.length - 1 : firstUnpassed;
  const allPassed = firstUnpassed === -1;

  const [index, setIndex] = useState(0);
  const initialisedRef = useRef(false);

  // Initialise the cursor ONCE, after both the persisted cursor and the provider
  // context have loaded, so the resume target is clamped against real gating.
  useEffect(() => {
    if (initialisedRef.current) return;
    if (contextLoading || !cursor.loaded) return;
    const target = initialStepId ?? cursor.persistedStepId;
    const desired =
      target != null ? steps.findIndex((s) => s.id === target) : maxReachable;
    const start = Math.min(
      Math.max(desired === -1 ? maxReachable : desired, 0),
      maxReachable,
    );
    setIndex(start);
    initialisedRef.current = true;
  }, [
    contextLoading,
    cursor.loaded,
    cursor.persistedStepId,
    initialStepId,
    maxReachable,
    steps,
  ]);

  // If the context regresses (e.g. a credential Replace re-arms verification and
  // shrinks the reachable range), clamp the current step back into range.
  useEffect(() => {
    if (initialisedRef.current && index > maxReachable) {
      setIndex(maxReachable);
    }
  }, [index, maxReachable]);

  function goTo(next: number) {
    const clamped = Math.min(Math.max(next, 0), maxReachable);
    setIndex(clamped);
    cursor.persist(steps[clamped].id, cursor.acknowledged);
  }

  // Acknowledge (skip) the active step and advance. Only an `optional` step can
  // actually be skipped this way — acknowledging adds it to the passed set, so
  // the next step becomes reachable. Persisting the enlarged acknowledged set
  // both records the skip and drives the re-derived gating on the next render.
  function acknowledgeActive() {
    const active = steps[index];
    if (active.optional !== true) return;
    const nextAcknowledged = Array.from(
      new Set([...cursor.acknowledged, active.id]),
    );
    const target = Math.min(index + 1, steps.length - 1);
    setIndex(target);
    cursor.persist(steps[target].id, nextAcknowledged);
  }

  // Banner frame rendered in EVERY branch (the live-region-position rule,
  // AGENTS.md / #2160): only the card below swaps, the banner stays mounted.
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      {viewOnlyBannerText}
    </AdminViewOnlySectionBanner>
  );

  if (contextLoading || !cursor.loaded) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="flex min-h-[240px] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
        </div>
      </div>
    );
  }

  const activeStep = steps[index];
  const helpers: WizardStepHelpers = {
    canEdit,
    refresh: onRefresh,
    goNext: () => goTo(index + 1),
    acknowledge: acknowledgeActive,
    isVerified: verifiedFlags[index],
  };
  const isLast = index === steps.length - 1;
  const currentPassed = passedFlags[index];

  return (
    <div>
      {viewOnlyBanner}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>{title}</CardTitle>
              {description ? (
                <CardDescription>{description}</CardDescription>
              ) : null}
            </div>
            <Badge variant={allPassed ? "success" : "secondary"}>
              {allPassed ? "Complete" : `Step ${index + 1} of ${steps.length}`}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Stepper — a completed/reachable step is a button; an upcoming
              (gated) step is disabled so the gate cannot be jumped. */}
          <ol className="grid gap-2 sm:grid-cols-3">
            {steps.map((step, i) => {
              const reachable = i <= maxReachable;
              const active = i === index;
              const done = passedFlags[i];
              return (
                <li key={step.id}>
                  <button
                    type="button"
                    onClick={() => reachable && goTo(i)}
                    disabled={!reachable}
                    aria-current={active ? "step" : undefined}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                      active
                        ? "border-primary bg-accent text-foreground"
                        : reachable
                          ? "border-border text-foreground hover:bg-accent"
                          : "cursor-not-allowed border-dashed border-border text-muted-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                        done
                          ? "border-emerald-600 bg-emerald-600 text-white"
                          : active
                            ? "border-primary text-foreground"
                            : "border-border text-muted-foreground",
                      )}
                    >
                      {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {step.title}
                      </span>
                      {step.summary ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {step.summary}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          <div className="rounded-md border p-4">
            {activeStep.render(context, helpers)}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => goTo(index - 1)}
              disabled={index === 0}
            >
              Back
            </Button>
            {isLast ? (
              allPassed ? (
                <Badge variant="success">
                  <Check className="mr-1 h-3.5 w-3.5" aria-hidden />
                  Setup complete
                </Badge>
              ) : (
                <span className="text-sm text-muted-foreground">
                  Complete this step to finish.
                </span>
              )
            ) : (
              <Button
                type="button"
                onClick={() => goTo(index + 1)}
                disabled={!currentPassed}
              >
                Continue
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
