import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { getRuntimeStatus } from "@/lib/health-check";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const unauthorized = requireCronSecret(request, { errorMessage: "Unauthorized" });
  if (unauthorized) return unauthorized;

  return NextResponse.json(getRuntimeStatus());
}
