import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { buildLoginPath, getExplicitCallbackUrl } from "@/lib/auth-redirect";
import { resolvePostLoginLandingPath } from "@/lib/post-login-landing";
import { TwoFactorVerifyPanel } from "../two-factor-panels";

function singleSearchParam(value?: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function TwoFactorVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}) {
  const params = await searchParams;
  // A genuinely explicit deep link only (null when absent/unsafe/self-referential).
  // The detour never carries a flow-materialised default, so this is the sole
  // "user asked for a specific page" signal here (D-D4).
  const explicitCallbackUrl =
    getExplicitCallbackUrl(singleSearchParam(params.callbackUrl)) ?? undefined;
  const session = await auth();

  if (!session?.user) {
    redirect(buildLoginPath(explicitCallbackUrl));
  }

  if (session.user.forcePasswordChange) {
    redirect("/change-password");
  }

  // Resolve the default landing here (#2090), from the live session's preference
  // + admin matrix (both refreshed by the auth jwt callback and unchanged by the
  // 2FA step), so post-verification navigation is deterministic — computed
  // server-side from the authoritative session, never a raced post-signIn fetch.
  // An explicit deep link still wins (D-D4). This is the single authoritative
  // resolution site for a member reaching verification via any entry point.
  const landing = resolvePostLoginLandingPath({
    explicitCallbackUrl,
    landingPreference: session.user.postLoginLanding,
    permissionInput: {
      adminPermissionMatrix: session.user.adminPermissionMatrix,
    },
  });

  if (!session.user.twoFactorRequired || session.user.twoFactorVerified) {
    redirect(landing);
  }

  if (!session.user.twoFactorEnrolled || !session.user.twoFactorMethod) {
    // Carry only the explicit deep link across to /login/enroll; that page
    // re-resolves the default the same way, so the detour hop never bakes one in.
    const query = new URLSearchParams();
    if (explicitCallbackUrl) {
      query.set("callbackUrl", explicitCallbackUrl);
    }
    const suffix = query.toString() ? `?${query.toString()}` : "";
    redirect(`/login/enroll${suffix}`);
  }

  return (
    <TwoFactorVerifyPanel
      callbackUrl={landing}
      enrolledMethod={session.user.twoFactorMethod}
    />
  );
}
