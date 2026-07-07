import { NextResponse } from "next/server";
import { z } from "zod";
import { updateBedAllocationSettings } from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationAdmin,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";

// requireAdmin() is enforced by requireBedAllocationAdmin().
const settingsSchema = z
  .object({
    autoAllocationEnabled: z.boolean(),
    // Lodge whose auto-allocation switch is edited; omitted keeps the
    // legacy club-wide row (lodge-scoping contract).
    lodgeId: z.string().min(1).optional(),
  })
  .strict();

export async function PUT(request: Request) {
  const guard = await requireBedAllocationAdmin();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = settingsSchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const settings = await updateBedAllocationSettings({
      autoAllocationEnabled: body.data.autoAllocationEnabled,
      updatedByMemberId: guard.session.user.id,
      lodgeId: body.data.lodgeId,
    });

    await createAuditLog({
      action: "BED_ALLOCATION_SETTINGS_UPDATED",
      memberId: guard.session.user.id,
      entityType: "BedAllocationSettings",
      entityId: body.data.lodgeId ?? "default",
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Bed allocation settings updated",
      metadata: settings,
    });

    return NextResponse.json({ settings });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
