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
  /** Whether this step is currently verified (its gate is satisfied). */
  isVerified: boolean;
  /** Whether THIS step is optional (may be skipped while unverified). */
  optional: boolean;
  /**
   * Whether THIS step has been acknowledged (skipped). Advisory only — it is
   * re-derived to `false` the moment the step verifies (verified > acknowledged),
   * so a step never shows both states at once.
   */
  acknowledged: boolean;
  /**
   * Acknowledge (skip) this optional, unverified step and advance. A no-op for a
   * required step or one already verified. The shell also renders a standalone
   * "skip" action for optional steps; a step may call this to drive its own
   * inline control instead. Load-bearing for C3 (skippable webhook step).
   */
  skip: () => void;
}

/**
 * Copy for an optional step's shell-rendered skip affordance. The provider
 * supplies the wording so the shell stays PROVIDER-NEUTRAL — the shell never
 * hard-codes provider copy. Both fields are optional; the shell falls back to
 * neutral defaults ({@link DEFAULT_WIZARD_SKIP_LABEL}).
 */
export interface WizardStepOptionalConfig {
  /** Label for the shell-rendered skip button (default "Skip for now"). */
  skipLabel?: string;
  /** One-line explanation of what skipping defers, shown beside the action. */
  skipDescription?: string;
}

/** Neutral default label the shell uses when a step supplies no `skipLabel`. */
export const DEFAULT_WIZARD_SKIP_LABEL = "Skip for now";

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
   * gating. Defaults to falsy (required).
   *
   * Pass `true` for the neutral "Skip for now" affordance, or a
   * {@link WizardStepOptionalConfig} to supply provider-specific skip copy. Any
   * truthy value marks the step optional; the shell renders a skip action while
   * the step is unverified and not yet acknowledged, and once the step later
   * verifies, verification supersedes the acknowledgement.
   */
  optional?: boolean | WizardStepOptionalConfig;
}

/** Whether a step is optional (skippable) — `optional` is any truthy value. */
export function isWizardStepOptional<Ctx>(step: WizardStepConfig<Ctx>): boolean {
  return Boolean(step.optional);
}

/**
 * Resolve the skip label + description for an optional step, falling back to the
 * neutral shell defaults. Returns empty copy for a required step (never used).
 */
export function getWizardStepSkipCopy<Ctx>(
  step: WizardStepConfig<Ctx>,
): { skipLabel: string; skipDescription: string } {
  const config =
    step.optional && typeof step.optional === "object" ? step.optional : {};
  return {
    skipLabel: config.skipLabel ?? DEFAULT_WIZARD_SKIP_LABEL,
    skipDescription: config.skipDescription ?? "",
  };
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
  /**
   * Copy shown once every step has passed. The provider supplies it so the
   * final state cannot read as "the WHOLE integration is done" when there is
   * still provider-specific configuration below the wizard (e.g. Xero account
   * mappings). All fields fall back to neutral shell defaults.
   */
  completion?: {
    /** Status-badge label when complete (default "Complete"). */
    badgeLabel?: string;
    /** Footer completion headline (default "Setup complete"). */
    message?: ReactNode;
    /** Optional secondary line pointing at the remaining configuration. */
    hint?: ReactNode;
  };
}
