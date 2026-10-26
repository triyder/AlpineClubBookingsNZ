import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { parseJsonRequestBody } from "@/lib/api-json";
import {
  getIntegrationWizardProgress,
  saveIntegrationWizardProgress,
} from "@/lib/integration-wizard-progress";

/**
 * The request handling every wizard-progress route shares (#2080, #4409),
 * AFTER that route's own literal `requireAdmin` gate has passed. Each route
 * passes only the wizard ids it stores (`WIZARD_PROGRESS_ROUTES`); any other id
 * answers 400, so a route can never read or write another area's wizard.
 */
export async function answerWizardProgressGet(
  request: Request,
  wizardIds: readonly string[],
): Promise<NextResponse> {
  const wizardId = new URL(request.url).searchParams.get("wizardId") ?? "";
  if (!wizardIds.includes(wizardId)) {
    return NextResponse.json({ error: "Unknown wizard." }, { status: 400 });
  }
  const progress = await getIntegrationWizardProgress(wizardId);
  return NextResponse.json({ wizardId, progress });
}

const bodySchema = z.object({
  wizardId: z.string().min(1).max(64),
  currentStepId: z.string().min(1).max(64),
  completedStepIds: z.array(z.string().min(1).max(64)).max(32),
});

export async function answerWizardProgressPost(
  request: Request,
  wizardIds: readonly string[],
  updatedByMemberId: string,
): Promise<NextResponse> {
  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const parsed = bodySchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { wizardId, currentStepId, completedStepIds } = parsed.data;
  if (!wizardIds.includes(wizardId)) {
    return NextResponse.json({ error: "Unknown wizard." }, { status: 400 });
  }
  const progress = await saveIntegrationWizardProgress({
    wizardId,
    currentStepId,
    completedStepIds,
    updatedByMemberId,
  });
  return NextResponse.json({ ok: true, wizardId, progress });
}
