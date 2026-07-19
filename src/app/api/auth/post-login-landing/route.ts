import { NextRequest, NextResponse } from "next/server";
import { resolvePostLoginLandingPath } from "@/lib/post-login-landing";
import { requireActiveSession } from "@/lib/session-guards";

// Post-auth landing resolver (#2090). The credential and magic-link login
// clients call this after a successful sign-in — once the session cookie
// exists — to learn where to navigate, honouring the member's landing
// preference and admin role default. Precedence and open-redirect safety live
// entirely in resolvePostLoginLandingPath; this route only supplies the
// session-derived preference + permission matrix (both refreshed per request by
// the auth jwt callback) and the caller's explicit callbackUrl, if any.
// A guard failure (deactivated member, forced password change) is harmless
// here: the login client falls back to its sanitized redirect and the
// change-password/self-heal flows take over.
export async function GET(req: NextRequest) {
  const guard = await requireActiveSession();
  if (!guard.ok) {
    return guard.response;
  }
  const { user } = guard.session;

  const explicitCallbackUrl = req.nextUrl.searchParams.get("callbackUrl");
  const path = resolvePostLoginLandingPath({
    explicitCallbackUrl,
    landingPreference: user.postLoginLanding,
    permissionInput: {
      adminPermissionMatrix: user.adminPermissionMatrix,
    },
  });

  return NextResponse.json({ path });
}
