import { NextResponse } from "next/server";
import { mockDisabledResponse } from "../_guard";

// Mock Xero consent page (#2080). Auto-approves and redirects straight back to
// the app's real callback with a code + the same state, so the OAuth callback
// route and its state-cookie check run unchanged. Test-only; 404 in production.
export async function GET(request: Request) {
  const disabled = mockDisabledResponse();
  if (disabled) return disabled;

  const url = new URL(request.url);
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  if (!redirectUri) {
    return NextResponse.json({ error: "missing redirect_uri" }, { status: 400 });
  }

  const target = new URL(redirectUri);
  target.searchParams.set("code", "mock-auth-code");
  if (state) target.searchParams.set("state", state);
  return NextResponse.redirect(target.toString());
}
