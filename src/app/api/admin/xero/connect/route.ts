import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getXeroConsentUrl } from "@/lib/xero";
import {
  createXeroOAuthState,
  getXeroOAuthStateCookieOptions,
  XERO_OAUTH_STATE_COOKIE,
} from "@/lib/xero-oauth-state";
import logger from "@/lib/logger";

/**
 * GET /api/admin/xero/connect
 * Redirects the admin to Xero's OAuth2 consent page.
 */
export async function GET(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  try {
    const state = createXeroOAuthState();
    const consentUrl = await getXeroConsentUrl(state);
    const response = NextResponse.redirect(consentUrl);
    response.cookies.set(
      XERO_OAUTH_STATE_COOKIE,
      state,
      getXeroOAuthStateCookieOptions(request.url)
    );
    return response;
  } catch (error) {
    logger.error({ err: error }, "Failed to generate Xero consent URL");
    return NextResponse.json({ error: "Failed to generate Xero consent URL" }, { status: 500 });
  }
}
