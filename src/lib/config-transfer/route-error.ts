import { NextResponse } from "next/server";

import logger from "@/lib/logger";
import { ConfigTransferBundleError } from "./bundle";

// Shared error → response mapping for the config-transfer admin routes. Curated
// errors (bad bundle) return their message as a 400; anything unexpected is
// logged server-side in full and returned as a STATIC 500 message — raw
// Prisma/library internals (constraint/column names) never reach the client,
// matching the admin-route convention elsewhere in the repo. With plan-time
// validation blocking bad rows, unknown apply-time errors should be rare; the
// app log carries the stack.
export function configTransferErrorResponse(
  context: string,
  error: unknown,
): NextResponse {
  if (error instanceof ConfigTransferBundleError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  logger.error({ err: error }, `config-transfer ${context} failed`);
  return NextResponse.json(
    { error: `${context} failed — the server log has the details.` },
    { status: 500 },
  );
}
