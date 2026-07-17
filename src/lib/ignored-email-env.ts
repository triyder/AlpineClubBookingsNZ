/**
 * #2021 (residual of #1986 / #2015): email identity is admin-managed, DB-first
 * (Admin → Email Messages). The legacy `EMAIL_FROM_NAME`, `SUPPORT_EMAIL`,
 * `CONTACT_EMAIL`, and `NEXT_PUBLIC_CONTACT_EMAIL` env vars were removed in
 * #1986 and are no longer read anywhere in the codebase. If a deployment still
 * sets one, its value is silently ignored. This helper builds a single
 * boot-time advisory warning naming the offending var(s) so an operator knows
 * the value has no effect and where the identity actually lives now.
 *
 * Pure and env-injectable so it is trivially unit-testable; the boot wiring in
 * `src/instrumentation.node.ts` logs the result once, best-effort.
 */

/** Env vars that #1986 stopped reading; their presence is now a no-op. */
const IGNORED_EMAIL_ENV_VARS = [
  "EMAIL_FROM_NAME",
  "SUPPORT_EMAIL",
  "CONTACT_EMAIL",
  "NEXT_PUBLIC_CONTACT_EMAIL",
] as const;

interface IgnoredEmailEnvWarning {
  /** The ignored env var names that are currently set to a non-empty value. */
  vars: string[];
  /** A single human-readable warning naming those vars. */
  message: string;
}

/**
 * Return a warning describing any ignored email-identity env var that is set to
 * a non-empty value, or `null` when none are set (the common case, so boot logs
 * nothing).
 */
export function getIgnoredEmailEnvWarning(
  env: Record<string, string | undefined> = process.env,
): IgnoredEmailEnvWarning | null {
  const vars = IGNORED_EMAIL_ENV_VARS.filter((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim() !== "";
  });

  if (vars.length === 0) return null;

  const list = vars.join(", ");
  const message =
    `Ignoring email-identity env var(s) ${list}: these were removed in #1986 ` +
    `and are no longer read. Email identity — sender display name, support ` +
    `address, and contact-form recipient — is admin-managed; set it under ` +
    `Admin → Email Messages.`;

  return { vars: [...vars], message };
}
