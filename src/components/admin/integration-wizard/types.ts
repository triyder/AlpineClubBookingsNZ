import type { ReactNode } from "react";

/**
 * Reusable guided-provider setup wizard — shared contract (#2080).
 *
 * The shell (`IntegrationWizard`) is PROVIDER-AGNOSTIC: it knows nothing about
 * Xero, Stripe or Google. A provider drives it entirely through data:
 *   - a `context` object of the provider's own derived server truth (`Ctx`), and
 *   - a `steps` array of {@link WizardStepConfig} that renders + verifies each
 *     step against that context.
 *
 * C4 (Stripe) and C5 (Google) reuse the shell by supplying their own `Ctx` and
 * `steps`; no shell change is required. See `src/app/(admin)/admin/xero/setup/`
 * for the Xero config as the worked example.
 */

/** Helpers the shell hands each step so it can render its own controls. */
export interface WizardStepHelpers {
  /**
   * Whether the current viewer may perform edit actions (e.g. Full Admin for a
   * credential step). Tri-state to match `useAdminAreaEditAccess`: `undefined`
   * while the session resolves (render neutral), then boolean.
   */
  canEdit: boolean | undefined;
  /** Re-derive the provider context (re-run verification after an action). */
  refresh: () => void;
  /** Advance to the next step. No-op unless this step is verified/passed. */
  goNext: () => void;
  /**
   * Acknowledge (skip) the current step and advance. Only meaningful for an
   * `optional` step: it records the step id in the acknowledged set so the shell
   * treats it as passed for gating (e.g. skipping the webhook step in C3, which
   * leaves the persistent amber badge until webhooks are later verified). A no-op
   * for a required step.
   */
  acknowledge: () => void;
  /** Whether this step is currently verified (its gate is satisfied). */
  isVerified: boolean;
}

/** One step, declared as data. `Ctx` is the provider's derived-state shape. */
export interface WizardStepConfig<Ctx> {
  /** Stable id (persisted as the resume cursor; used in deep links). */
  id: string;
  /** Stepper label. */
  title: string;
  /** Optional one-line stepper summary. */
  summary?: string;
  /** Render the step body against the provider context + shell helpers. */
  render: (context: Ctx, helpers: WizardStepHelpers) => ReactNode;
  /**
   * Is this step's gate satisfied by the current context? The shell will not let
   * the operator advance PAST this step until this returns true (or the step is
   * optional and acknowledged). Always derived from live server truth — never
   * from a persisted flag.
   */
  isVerified: (context: Ctx) => boolean;
  /**
   * Optional steps (e.g. webhooks in C3) may be acknowledged/skipped instead of
   * verified; the shell then treats an acknowledged optional step as passed for
   * gating. Defaults to false (required).
   */
  optional?: boolean;
}

export interface IntegrationWizardProps<Ctx> {
  /** Persistence + deep-link namespace, matching the provider ("xero"). */
  wizardId: string;
  title: string;
  description?: ReactNode;
  steps: WizardStepConfig<Ctx>[];
  /** Provider-derived server truth the steps verify against. */
  context: Ctx;
  /** True while the provider is still loading its context (render neutral). */
  contextLoading: boolean;
  /** Re-derive the provider context. */
  onRefresh: () => void;
  /** Tri-state edit access for the view-only banner frame. */
  canEdit: boolean | undefined;
  /** Sentence shown in the view-only banner when `canEdit === false`. */
  viewOnlyBanner: ReactNode;
  /**
   * Optional deep-link target step id (e.g. from a readiness "blocked" link).
   * Clamped to the furthest reachable step, so a link can never jump the gate.
   */
  initialStepId?: string;
}
