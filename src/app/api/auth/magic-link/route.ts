import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { sendMagicLinkEmail } from "@/lib/email";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { issueActionToken } from "@/lib/action-tokens";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { loadMagicLinkTtlMinutes, magicLinkTtlMs } from "@/lib/magic-link";

const magicLinkSchema = z.object({
  email: z.string().email("Invalid email address"),
});

// Mirrors forgot-password/route.ts exactly: rate-limited, enumeration-safe
// (always {success:true}, no signal about whether the email exists), and
// fire-and-forget send. Deliberately STRICTER than forgot-password: it serves
// only active AND verified members with the module enabled. forgot-password
// serves unverified members so first-time setup works; magic link must never
// be an email-verification bypass (owner decision, #2030), so unverified
// members get the identical silent response and zero email.
export async function POST(req: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.magicLinkRequest, req);
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  try {
    const parsed = magicLinkSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 400 },
      );
    }

    const { email } = parsed.data;

    const modules = await loadEffectiveModuleFlags();

    // Always return success to avoid leaking which emails are registered.
    const member = await prisma.member.findFirst({
      where: { email: email.toLowerCase(), canLogin: true },
    });

    // Send only when the module is enabled AND the member is active AND their
    // email is verified. Any other case is a silent no-op with the same
    // response, so enabling/disabling the module and account state never leak.
    if (modules.magicLink && member && member.active && member.emailVerified) {
      const { token, tokenHash } = issueActionToken();
      const ttlMinutes = await loadMagicLinkTtlMinutes();
      const expiresAt = new Date(Date.now() + magicLinkTtlMs(ttlMinutes));

      // Invalidate any existing magic-link tokens for this member so only the
      // most recent link is live.
      await prisma.magicLinkToken.deleteMany({
        where: { memberId: member.id },
      });

      await prisma.magicLinkToken.create({
        data: {
          tokenHash,
          memberId: member.id,
          expiresAt,
        },
      });

      // Fire-and-forget — don't reveal failure to the client.
      sendMagicLinkEmail(member.email, token).catch((err) => {
        logger.error({ err }, "Failed to send magic-link sign-in email");
      });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Unexpected error in magic-link request");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
