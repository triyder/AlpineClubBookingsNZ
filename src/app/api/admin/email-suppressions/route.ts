import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getEmailDeliverabilityTelemetry } from "@/lib/email-suppression";

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  return NextResponse.json(await getEmailDeliverabilityTelemetry());
}
