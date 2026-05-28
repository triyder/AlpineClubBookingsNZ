import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { redactExpiredIssueReportSensitiveData } from "@/lib/issue-report-retention";
import logger from "@/lib/logger";

export async function POST(request: NextRequest) {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  try {
    const result = await redactExpiredIssueReportSensitiveData();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "Issue report retention cron failed");
    return NextResponse.json(
      { error: "Failed to redact expired issue report data" },
      { status: 500 }
    );
  }
}
