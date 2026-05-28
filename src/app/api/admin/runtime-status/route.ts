import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getRuntimeStatus } from "@/lib/health-check";

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  return NextResponse.json(getRuntimeStatus());
}
