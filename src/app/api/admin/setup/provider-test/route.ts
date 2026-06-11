import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { getStripe } from "@/lib/stripe";

const providerTestSchema = z.object({
  provider: z.enum(["stripe", "smtp", "sentry", "xero", "finance-xero"]),
});

type Provider = z.infer<typeof providerTestSchema>["provider"];

async function withTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  const timeoutMs = 10_000;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs),
    ),
  ]);
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

async function testStripe() {
  if (!readEnv("STRIPE_SECRET_KEY")) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }

  await withTimeout("Stripe balance check", getStripe().balance.retrieve());
  return "Stripe responded to a balance read using the configured key.";
}

async function testSmtp() {
  const host = readEnv("SMTP_HOST");
  const user = readEnv("AWS_SES_ACCESS_KEY_ID");
  const pass = readEnv("AWS_SES_SECRET_ACCESS_KEY");
  if (!host || !user || !pass) {
    throw new Error("SMTP_HOST, AWS_SES_ACCESS_KEY_ID, and AWS_SES_SECRET_ACCESS_KEY are required");
  }

  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.default.createTransport({
    host,
    port: Number(readEnv("SMTP_PORT")) || 587,
    secure: false,
    auth: { user, pass },
  });
  await withTimeout("SMTP verify", transporter.verify());
  return "SMTP verification completed successfully.";
}

async function testSentry() {
  if (!readEnv("SENTRY_DSN")) {
    throw new Error("SENTRY_DSN is not configured");
  }

  Sentry.captureMessage("Setup wizard diagnostic event", {
    level: "info",
    tags: { source: "setup-wizard" },
  });
  const flushed = await withTimeout("Sentry flush", Sentry.flush(5000));
  if (!flushed) {
    throw new Error("Sentry did not flush the diagnostic event before timeout");
  }
  return "Sentry accepted a diagnostic event flush.";
}

async function testOperationalXero() {
  const token = await prisma.xeroToken.findFirst({
    orderBy: { updatedAt: "desc" },
    select: { expiresAt: true, tenantId: true },
  });
  if (!token) {
    throw new Error("Operational Xero is not connected");
  }
  if (token.expiresAt <= new Date()) {
    throw new Error("Operational Xero token is expired");
  }
  return `Operational Xero token is active for tenant ${token.tenantId ?? "unknown"}.`;
}

async function testFinanceXero() {
  const token = await prisma.financeXeroToken.findFirst({
    orderBy: { updatedAt: "desc" },
    select: { expiresAt: true, tenantId: true },
  });
  if (!token) {
    throw new Error("Finance Xero is not connected");
  }
  if (token.expiresAt <= new Date()) {
    throw new Error("Finance Xero token is expired");
  }
  return `Finance Xero token is active for tenant ${token.tenantId ?? "unknown"}.`;
}

async function runProviderTest(provider: Provider) {
  switch (provider) {
    case "stripe":
      return testStripe();
    case "smtp":
      return testSmtp();
    case "sentry":
      return testSentry();
    case "xero":
      return testOperationalXero();
    case "finance-xero":
      return testFinanceXero();
  }
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = providerTestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const checkedAt = new Date().toISOString();
  try {
    const message = await runProviderTest(parsed.data.provider);
    await logAudit({
      action: "setup_provider_test",
      memberId: session.user.id,
      category: "system",
      outcome: "success",
      summary: `Setup provider test succeeded: ${parsed.data.provider}`,
      metadata: { provider: parsed.data.provider },
    });
    return NextResponse.json({
      ok: true,
      provider: parsed.data.provider,
      checkedAt,
      message,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Provider test failed";
    await logAudit({
      action: "setup_provider_test",
      memberId: session.user.id,
      category: "system",
      outcome: "failure",
      summary: `Setup provider test failed: ${parsed.data.provider}`,
      metadata: { provider: parsed.data.provider, error: message },
    });
    return NextResponse.json({
      ok: false,
      provider: parsed.data.provider,
      checkedAt,
      message,
    });
  }
}
