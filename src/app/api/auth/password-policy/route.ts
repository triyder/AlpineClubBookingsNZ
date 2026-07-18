import { NextResponse } from "next/server";
import { loadLoginSecuritySettings } from "@/lib/login-security-settings";
import { describePolicy, PASSWORD_MAX_LENGTH } from "@/lib/password-policy";

// Public, unauthenticated policy-hints endpoint (epic #2030, child #2033).
// Feeds live password-requirement hints to the reset-password / change-password
// forms so the member sees the club's rules before submitting. Disclosing the
// password policy is standard and safe — the same rules are enforced server-side
// regardless. Only the password-relevant fields are exposed; magicLinkTtlMinutes
// (an internal login-flow setting for #2034) is intentionally NOT returned.
export async function GET() {
  const { policy } = await loadLoginSecuritySettings();
  return NextResponse.json({
    minPasswordLength: policy.minPasswordLength,
    maxPasswordLength: PASSWORD_MAX_LENGTH,
    requireUppercase: policy.requireUppercase,
    requireLowercase: policy.requireLowercase,
    requireDigit: policy.requireDigit,
    requireSymbol: policy.requireSymbol,
    hints: describePolicy(policy),
  });
}
