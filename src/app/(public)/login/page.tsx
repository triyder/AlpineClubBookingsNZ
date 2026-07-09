import { isValidAuthBounceRef, resolvePostLoginPath } from "@/lib/auth-redirect";
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
  }>;
}) {
  const params = await searchParams;
  const verified = singleSearchParam(params.verified) === "true";
  const emailChanged = singleSearchParam(params.emailChanged) === "true";
  const verifyError = singleSearchParam(params.verifyError);
  const redirectTo = resolvePostLoginPath(singleSearchParam(params.callbackUrl));
  const refCandidate = singleSearchParam(params.ref);
  const authBounceRef = isValidAuthBounceRef(refCandidate) ? refCandidate : undefined;

  return (
    <LoginForm
      verified={verified}
      verifyError={verifyError}
      emailChanged={emailChanged}
      redirectTo={redirectTo}
      authBounceRef={authBounceRef}
    />
  );
}
