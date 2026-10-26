/**
 * Reusable guided-provider setup wizard shell (#2080).
 *
 * PROVIDER-AGNOSTIC public surface. Provider setup flows (Xero, Stripe, Google,
 * display, backups) build their flows by importing these and supplying their
 * own `context` + `steps`; nothing here names or imports a specific provider.
 *
 * Only the four symbols every provider actually reaches through this barrel are
 * re-exported. The shell's internal helpers — the `useWizardCursor` hook, the
 * `isWizardStepOptional` / `getWizardStepSkipCopy` step-skip predicates,
 * `DEFAULT_WIZARD_SKIP_LABEL`, and the `IntegrationWizardProps` /
 * `WizardStepOptionalConfig` types — are imported directly from `./types` and
 * `./use-integration-wizard` where they are used and are intentionally not
 * surfaced here: no provider consumes them by name, so re-exporting them only
 * created dead barrel specifiers (knip 6.29+, #2502). Re-add a symbol here the
 * day a provider needs to import it through the barrel.
 */
export { IntegrationWizard } from "./integration-wizard";
export { CopyField } from "./copy-field";
export { useStepSaving } from "./use-step-saving";
export type { WizardStepConfig, WizardStepHelpers } from "./types";
