import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  GOOGLE_LINK_INTENT_COOKIE,
  GOOGLE_LINK_INTENT_TTL_SECONDS,
  buildGoogleLinkIntentValue,
  googleCredentialsConfigured,
} from "@/lib/google-oauth";

// Profile-initiated Google account linking, step 1 (#2035). An AUTHENTICATED
// member calls this before `signIn("google")`; it sets a short-lived, HttpOnly,
// HMAC-signed cookie that binds this member's id. The signIn callback reads the
// cookie on the OAuth callback and performs the link (see src/lib/google-oauth.ts
// for the full CSRF-safety argument). Never sets a session; never links here.
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  // Defence in depth: the button is only rendered when the module is on and the
  // per-club Google credentials are configured, but refuse server-side too so a
  // wasted OAuth round-trip cannot be started while Google sign-in is off.
  const modules = await loadEffectiveModuleFlags();
  if (!modules.googleLogin || !googleCredentialsConfigured()) {
    return NextResponse.json(
      { error: "Google sign-in is not enabled." },
      { status: 403 },
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(
    GOOGLE_LINK_INTENT_COOKIE,
    buildGoogleLinkIntentValue(session.user.id),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      // Lax so the cookie is sent on Google's top-level GET redirect back to the
      // OAuth callback, but never on cross-site subrequests.
      sameSite: "lax",
      path: "/",
      maxAge: GOOGLE_LINK_INTENT_TTL_SECONDS,
    },
  );
  return res;
}
