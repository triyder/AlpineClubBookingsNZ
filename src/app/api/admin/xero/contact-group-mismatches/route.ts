import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { getXeroContactGroupMismatchSnapshot } from "@/lib/age-tier-xero-groups";
import logger from "@/lib/logger";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse({
    limit: request.nextUrl.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const snapshot = await getXeroContactGroupMismatchSnapshot(parsed.data);
    return NextResponse.json(snapshot);
  } catch (error) {
    logger.error({ err: error }, "Failed to load Xero contact group mismatch snapshot");
    return NextResponse.json(
      { error: "Failed to load Xero contact group mismatch snapshot" },
      { status: 500 }
    );
  }
}
