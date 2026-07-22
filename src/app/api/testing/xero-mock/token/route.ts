import { NextResponse } from "next/server";
import { mockDisabledResponse } from "../_guard";

// Mock Xero token exchange (#2080). Test-only; 404 in production.
export async function POST() {
  const disabled = mockDisabledResponse();
  if (disabled) return disabled;

  return NextResponse.json({
    access_token: "mock-access-token",
    refresh_token: "mock-refresh-token",
    expires_in: 1800,
    token_type: "Bearer",
  });
}
