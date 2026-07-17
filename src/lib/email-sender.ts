import { clubConfig, SAFE_DEFAULT_CONFIG } from "@/config/club";

// Envelope sender (C6 #1985): the actual From/Return-Path ADDRESS is a BOOTSTRAP
// concern — it must be a provider-verified sender (SES), not an arbitrary
// club.json value — so it resolves from the `EMAIL_FROM` bootstrap env var,
// falling back to `SAFE_DEFAULT_CONFIG.supportEmail` (never club.json). This
// constant is always truthy, so the DB-first EmailMessageSetting.supportEmail is
// NEVER the From/envelope address: the DB supportEmail governs the body/footer
// support links (search-key replacement) and the DB emailFromName governs the
// From DISPLAY NAME only. Production must set EMAIL_FROM to a provider-verified
// address. `EMAIL_FROM` is the ONLY email-identity env var (besides transport
// secrets) — the sanctioned transport bootstrap.
export const EMAIL_FROM = process.env.EMAIL_FROM || SAFE_DEFAULT_CONFIG.supportEmail;
// SUPPORT_EMAIL / EMAIL_FROM_NAME are STABLE SEARCH KEYS baked into email
// templates: `applyEmailMessageSettingsToHtml` replaces these config-derived
// defaults with the live DB-first EmailMessageSetting values at send time, so
// they MUST stay aligned with `getDefaultEmailMessageSettings()`
// (config-derived), NOT the safe default, or the substitution would silently
// no-op for a real club. They are purely config-derived (C7 #1986 removed the
// `SUPPORT_EMAIL` / `EMAIL_FROM_NAME` env overrides: EmailMessageSetting is now
// the single source for email identity). This is the email bootstrap search-key
// layer; delivered mail always shows the DB value.
export const SUPPORT_EMAIL = clubConfig.supportEmail;
const EMAIL_FROM_NAME = clubConfig.emailFromName;

export function formatEmailFromAddress(fromAddress = EMAIL_FROM): string {
  return `"${EMAIL_FROM_NAME}" <${fromAddress}>`;
}
