import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  getExplicitCallbackUrl,
  isValidAuthBounceRef,
  resolvePostLoginPath,
} from "@/lib/auth-redirect";
import { resolvePostLoginLandingPath } from "@/lib/post-login-landing";
import { googleCredentialsConfigured } from "@/lib/google-oauth";
import { getCachedEffectiveModuleFlags } from "@/lib/public-layout-config";
import { LoginForm } from "./login-form";

function singleSearchParam(value?: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

// Server component: resolve the login query params here so the client form
// never needs useSearchParams(). Reading them client-side forced the form into
// a Suspense boundary whose hard-load hydration is the suspected cause of the
// #email double-render E2E flake (#1207/#1140).
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    verified?: string | string[];
    verifyError?: string | string[];
    emailChanged?: string | string[];
    callbackUrl?: string | string[];
    ref?: string | string[];
    error?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const verified = singleSearchParam(params.verified) === "true";
  const emailChanged = singleSearchParam(params.emailChanged) === "true";
  const verifyError = singleSearchParam(params.verifyError);
  const oauthError = singleSearchParam(params.error);
  const rawCallbackUrl = singleSearchParam(params.callbackUrl);
  const redirectTo = resolvePostLoginPath(rawCallbackUrl);
  // A genuinely user/deep-link-supplied callbackUrl (null when absent/unsafe).
  // It always wins over the landing preference (D-D4); when absent the client
  // and the authenticated self-heal below fall back to the preference / role
  // default. Never treat a flow-materialised default as explicit.
  const explicitCallbackUrl = getExplicitCallbackUrl(rawCallbackUrl) ?? undefined;
  const refCandidate = singleSearchParam(params.ref);
  const authBounceRef = isValidAuthBounceRef(refCandidate) ? refCandidate : undefined;

  // An already-authenticated visitor must never be shown the sign-in form —
  // a bounced tab would otherwise strand on /login with no error and no way
  // to self-heal. Mirror login/verify's session-aware gates so the redirect
  // still honours a forced password change and the two-factor funnel.
  const session = await auth();
  if (session?.user) {
    if (session.user.forcePasswordChange) {
      redirect("/change-password");
    }
    // When a 2FA challenge is still open, hand off to the verify/enroll detour.
    // Determinism (#2090): the detour's callbackUrl carries ONLY a genuinely
    // explicit deep link — never the resolved default landing. The default is
    // re-resolved at /login/verify and /login/enroll from the fully-authed
    // session, so every entry into the detour resolves the default the SAME way
    // and a flow-materialised default is never re-read as explicit (D-D4).
    if (session.user.twoFactorRequired && !session.user.twoFactorVerified) {
      const query = new URLSearchParams();
      if (explicitCallbackUrl) {
        query.set("callbackUrl", explicitCallbackUrl);
      }
      const suffix = query.toString() ? `?${query.toString()}` : "";
      redirect(
        session.user.twoFactorEnrolled && session.user.twoFactorMethod
          ? `/login/verify${suffix}`
          : `/login/enroll${suffix}`,
      );
    }
    // No detour: resolve the landing from the live session so an admin's
    // preference / role default is honoured on this self-heal path (and,
    // notably, this is where a Google sign-in with no explicit deep link lands
    // to be resolved).
    const landing = resolvePostLoginLandingPath({
      explicitCallbackUrl,
      landingPreference: session.user.postLoginLanding,
      permissionInput: {
        adminPermissionMatrix: session.user.adminPermissionMatrix,
      },
    });
    redirect(landing);
  }

  // Only needed on the form-render path (an authenticated visitor redirects
  // above). Mirrors the public layout's cached read of effective module flags.
  const modules = await getCachedEffectiveModuleFlags();

  return (
    <LoginForm
      verified={verified}
      verifyError={verifyError}
      emailChanged={emailChanged}
      redirectTo={redirectTo}
      explicitCallbackUrl={explicitCallbackUrl}
      authBounceRef={authBounceRef}
      magicLinkEnabled={modules.magicLink}
      googleLoginEnabled={modules.googleLogin && googleCredentialsConfigured()}
      oauthError={oauthError}
    />
  );
}
