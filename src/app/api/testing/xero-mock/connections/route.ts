import { NextResponse } from "next/server";
import {
  MOCK_XERO_ORG_NAME,
  MOCK_XERO_TENANT_ID,
} from "@/lib/xero-mock-endpoint";
import { mockDisabledResponse } from "../_guard";

// Mock Xero connections (tenants) list (#2080). Test-only; 404 in production.
export async function GET() {
  const disabled = mockDisabledResponse();
  if (disabled) return disabled;

  return NextResponse.json([
    {
      tenantId: MOCK_XERO_TENANT_ID,
      tenantName: MOCK_XERO_ORG_NAME,
      tenantType: "ORGANISATION",
    },
  ]);
}
