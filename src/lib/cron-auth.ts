import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

export function isValidCronSecret(
  provided: string | null,
  expected: string | undefined = process.env.CRON_SECRET
) {
  if (!provided || !expected) {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

export function requireCronSecret(
  request: Request,
  options: { errorMessage?: string } = {}
) {
  if (isValidCronSecret(request.headers.get("x-cron-secret"))) {
    return null;
  }

  return NextResponse.json(
    { error: options.errorMessage ?? "Unauthorised" },
    { status: 401 }
  );
}
