"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Post-login destination for a magic-link sign-in. The email carries no
// callbackUrl, so we always land on the default authenticated home; the 2FA
// funnel below still diverts to /login/verify or /login/enroll when required.
const POST_LOGIN_PATH = "/dashboard";

// Mirror the password login's post-login navigation so a 2FA-enabled member is
// still challenged after a magic-link sign-in. Returns the 2FA / change-password
// path, or null to fall through to the default authenticated home.
async function resolveTwoFactorPath(): Promise<string | null> {
  const response = await fetch("/api/auth/2fa/status", {
    credentials: "same-origin",
  });
  if (!response.ok) return null;
  const twoFactorStatus = (await response.json()) as {
    required?: boolean;
    verified?: boolean;
    enrolled?: boolean;
    forcePasswordChange?: boolean;
  };

  if (twoFactorStatus.forcePasswordChange) {
    return "/change-password";
  }

  if (!twoFactorStatus.required || twoFactorStatus.verified) {
    return null;
  }

  const params = new URLSearchParams({ callbackUrl: POST_LOGIN_PATH });
  return twoFactorStatus.enrolled
    ? `/login/verify?${params.toString()}`
    : `/login/enroll?${params.toString()}`;
}

type Status = "verifying" | "error" | "password-change";

function MagicSignIn() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<Status>("verifying");
  // Strict-mode / re-render guard: the sign-in must fire exactly once, since the
  // token is single-use — a second attempt would always fail as "already used".
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const token = searchParams.get("token") ?? "";

    // Remove the token from the visible URL / history so the single-use secret
    // does not linger in the address bar or the back/forward stack.
    if (typeof window !== "undefined" && token) {
      window.history.replaceState(null, "", "/login/magic");
    }

    if (!token) {
      setStatus("error");
      return;
    }

    async function run() {
      try {
        const result = await signIn("magic-link", {
          token,
          redirect: false,
        });

        if (!result || result.error) {
          if (
            result?.code === "PASSWORD_CHANGE_REQUIRED" ||
            result?.error === "PASSWORD_CHANGE_REQUIRED"
          ) {
            setStatus("password-change");
          } else {
            // Invalid / expired / already-used / unverified all collapse to the
            // same generic message — nothing about which case applies leaks.
            setStatus("error");
          }
          return;
        }

        // Signed in. Mirror the password login's post-login navigation so a
        // 2FA-enabled member is still challenged. Full document navigation
        // (never router.push) sends the fresh session cookie and avoids the
        // logged-out RSC cache bounce (#1669).
        window.location.assign((await resolveTwoFactorPath()) ?? POST_LOGIN_PATH);
      } catch {
        setStatus("error");
      }
    }

    void run();
  }, [searchParams]);

  if (status === "verifying") {
    return (
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-center text-2xl font-bold">
            Signing you in…
          </CardTitle>
          <CardDescription className="text-center">
            Please wait while we verify your sign-in link.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (status === "password-change") {
    return (
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-center text-2xl font-bold">
            Set a new password to continue
          </CardTitle>
          <CardDescription className="text-center">
            Your account needs a password change before you can sign in. Use
            Forgot password to set a new one, then sign in.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Link href="/forgot-password" className="w-full">
            <Button className="w-full">Forgot password</Button>
          </Link>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1">
        <CardTitle className="text-center text-2xl font-bold">
          This sign-in link didn&apos;t work
        </CardTitle>
        <CardDescription className="text-center">
          It may have expired, already been used, or be invalid. Request a fresh
          link, or sign in with your password.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Link href="/login" className="w-full">
          <Button className="w-full">Back to sign in</Button>
        </Link>
      </CardContent>
    </Card>
  );
}

export default function MagicLinkPage() {
  return (
    <>
      {/* Keep the single-use token out of the Referer header on any outbound
          navigation or subresource load from this page. */}
      <meta name="referrer" content="no-referrer" />
      <Suspense
        fallback={
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-center">Loading…</CardTitle>
            </CardHeader>
          </Card>
        }
      >
        <MagicSignIn />
      </Suspense>
    </>
  );
}
