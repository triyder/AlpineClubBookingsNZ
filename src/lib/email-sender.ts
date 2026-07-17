import { clubConfig, SAFE_DEFAULT_CONFIG } from "@/config/club";

// Envelope sender (C6 #1985): the actual From/Return-Path address is a BOOTSTRAP
// concern — it must be a provider-verified sender (SES), not an arbitrary
// club.json value — so it resolves from the `EMAIL_FROM` bootstrap env var,
// falling back to `SAFE_DEFAULT_CONFIG.supportEmail` (never club.json). Every
// real send path passes this through `formatEmailFromAddressWithSettings`
// (email-message-settings.ts), which prefers the DB-first
// EmailMessageSetting.supportEmail when `EMAIL_FROM` is unset. C7 owns removing
// the env term.
export const EMAIL_FROM = process.env.EMAIL_FROM || SAFE_DEFAULT_CONFIG.supportEmail;
// SUPPORT_EMAIL / EMAIL_FROM_NAME are STABLE SEARCH KEYS baked into email
// templates: `applyEmailMessageSettingsToHtml` replaces these config-derived
// defaults (or the matching env overrides) with the live DB-first
// EmailMessageSetting values at send time, so they MUST stay aligned with
// `getDefaultEmailMessageSettings()` (config-derived), NOT the safe default, or
// the substitution would silently no-op for a real club. This is the email
// bootstrap search-key layer; delivered mail always shows the DB value.
export const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || clubConfig.supportEmail;
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || clubConfig.emailFromName;

export function formatEmailFromAddress(fromAddress = EMAIL_FROM): string {
  return `"${EMAIL_FROM_NAME}" <${fromAddress}>`;
}
