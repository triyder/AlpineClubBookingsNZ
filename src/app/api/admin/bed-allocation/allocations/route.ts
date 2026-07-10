import { NextResponse } from "next/server";
import { z } from "zod";
import { manuallyAllocateBed } from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationAdmin,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";

// requireAdmin() is enforced by requireBedAllocationAdmin().
const manualAllocationSchema = z
  .object({
    bookingGuestId: z.string().min(1),
    bedId: z.string().min(1),
    stayDate: z.string().min(1),
  })
  .strict();

export async function POST(request: Request) {
  const guard = await requireBedAllocationAdmin();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = manualAllocationSchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const { allocation, promotedPartner } = await manuallyAllocateBed(body.data);
    await createAuditLog({
      action: "BED_ALLOCATION_MANUAL_SET",
      memberId: guard.session.user.id,
      targetId: allocation.bookingId,
      entityType: "BedAllocation",
      entityId: allocation.id,
      category: "admin",
      outcome: "success",
      summary: "Manual bed allocation set",
      metadata: {
        allocationId: allocation.id,
        bookingGuestId: allocation.bookingGuestId,
        bedId: allocation.bedId,
        stayDate: allocation.stayDate,
      },
    });
    // Moving a shared double's primary onto another bed auto-promotes the
    // partner left on the OLD bed-night (#1750). The partner may belong to a
    // different booking, so it gets its own audit entry against that booking.
    if (promotedPartner) {
      await createAuditLog({
        action: "BED_ALLOCATION_PARTNER_PROMOTED",
        memberId: guard.session.user.id,
        targetId: promotedPartner.bookingId,
        entityType: "BedAllocation",
        entityId: promotedPartner.id,
        category: "admin",
        outcome: "success",
        summary:
          "Second occupant auto-promoted to primary after the shared double's primary was moved to another bed",
        metadata: {
          allocationId: promotedPartner.id,
          bedId: promotedPartner.bedId,
          stayDate: promotedPartner.stayDate,
          movedAllocationId: allocation.id,
        },
      });
    }

    return NextResponse.json({ allocation });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
