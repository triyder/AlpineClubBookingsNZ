import { NextResponse } from "next/server";
import { MOCK_XERO_ITEMS } from "@/lib/xero-mock-endpoint";
import { mockDisabledResponse } from "../_guard";

// Mock Xero items (#2081). Backs the wizard account-mapping step's item pickers.
// Test-only; 404 in production.
export async function GET() {
  const disabled = mockDisabledResponse();
  if (disabled) return disabled;

  return NextResponse.json([...MOCK_XERO_ITEMS]);
}
