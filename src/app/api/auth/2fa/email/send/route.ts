import { NextRequest, NextResponse } from "next/server";
import { sendTwoFactorCodeEmail } from "@/lib/email";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { createTwoFactorEmailCode } from "@/lib/two-factor";
import {
  passwordChangeRequiredResponse,
  requireTwoFactorApiSession,
  twoFactorLockoutResponse,
} from "@/lib/two-factor-api";

export async function POST(request: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.twoFactorVerify, request);
  if (rateLimited) return rateLimited;

  const guard = await requireTwoFactorApiSession();
  if (!guard.ok) return guard.response;

  if (guard.member.forcePasswordChange) {
    return passwordChangeRequiredResponse();
  }

  const locked = twoFactorLockoutResponse(guard.member);
  if (locked) return locked;

  if (!guard.session.user.twoFactorRequired) {
    return NextResponse.json(
      { error: "Two-factor authentication is not required" },
      { status: 400 },
    );
  }

  if (guard.session.user.twoFactorVerified) {
    return NextResponse.json(
      { error: "Two-factor authentication is already verified" },
      { status: 400 },
    );
  }

  if (
    guard.member.twoFactorEnabled &&
    guard.member.twoFactorMethod !== "EMAIL"
  ) {
    return NextResponse.json(
      { error: "Email codes are not enrolled for this account" },
      { status: 400 },
    );
  }

  const { code, expiresAt } = await createTwoFactorEmailCode(guard.member.id);
  await sendTwoFactorCodeEmail({
    email: guard.member.email,
    firstName: guard.member.firstName,
    code,
    expiresAt,
  });

  return NextResponse.json({ ok: true, expiresAt: expiresAt.toISOString() });
}
