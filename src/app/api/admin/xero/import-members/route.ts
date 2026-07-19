import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { getAuditRequestContext } from "@/lib/audit";
import { requireAdmin } from "@/lib/session-guards";
import {
  importMembersFromXeroGroups,
  XeroDailyLimitError,
  XeroMemberImportValidationError,
} from "@/lib/xero";
import logger from "@/lib/logger";

const importSchema = z.object({
  groupMappings: z
    .array(
      z
        .object({
          groupId: z.string().min(1),
          groupName: z.string().min(1),
          // Person tiers only — the API never accepts an explicit NOT_APPLICABLE.
          // N/A is only ever DERIVED from an age-exempt membership type (#2108).
          ageTier: bookableAgeTierEnum.optional(),
          membershipTypeId: z.string().min(1).optional(),
        })
        .refine(
          (mapping) => Boolean(mapping.ageTier) || Boolean(mapping.membershipTypeId),
          {
            message: "Each mapping needs an age tier, a membership type, or both",
          },
        ),
    )
    .min(1, "At least one group mapping is required"),
  sendInvites: z.boolean().default(false),
  repairMissingContactCache: z.boolean().default(false),
});

/**
 * POST /api/admin/xero/import-members
 * Import members from cached Xero contact groups into the local member table.
 * Repair mode can fetch only missing cached contact snapshots from Xero.
 *
 * Gating (#2108, owner decision): the route's inferred base area is `finance`.
 * A mapping that carries a `membershipTypeId` opens a membership-assignment
 * write path, so the handler additionally requires `membership:edit` — a
 * finance-only admin is rejected. Age-tier-only imports stay finance-gated.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = importSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const hasTypeMappings = parsed.data.groupMappings.some(
    (mapping) => Boolean(mapping.membershipTypeId),
  );
  // In-handler membership:edit requirement IN ADDITION to the inferred finance
  // gate. `requireAdmin` composes the two — a finance-only admin passes the
  // first guard but fails this one with a clear 403.
  if (hasTypeMappings) {
    const membershipGuard = await requireAdmin({
      permission: { area: "membership", level: "edit" },
      forbiddenResponse: () =>
        NextResponse.json(
          {
            error:
              "Importing members into membership types requires membership edit access. Your account has finance access only.",
          },
          { status: 403 },
        ),
    });
    if (!membershipGuard.ok) return membershipGuard.response;
  }

  try {
    logger.info(
      {
        groupCount: parsed.data.groupMappings.length,
        withMembershipType: parsed.data.groupMappings.filter(
          (mapping) => Boolean(mapping.membershipTypeId),
        ).length,
        groups: parsed.data.groupMappings
          .map(
            (g) =>
              `${g.groupName} (${g.ageTier ?? "-"}${
                g.membershipTypeId ? `, type:${g.membershipTypeId}` : ""
              })`,
          )
          .join(", "),
      },
      "Starting member import from Xero",
    );
    const result = await importMembersFromXeroGroups(
      parsed.data.groupMappings,
      parsed.data.sendInvites,
      {
        allowLiveXeroFetch: parsed.data.repairMissingContactCache,
        adminMemberId: guard.session.user.id,
        request: getAuditRequestContext(req),
      }
    );
    logger.info({ result }, "Member import from Xero completed");
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof XeroMemberImportValidationError) {
      logger.warn(
        { offenders: error.offenders },
        "Member import rejected — invalid membership type(s)",
      );
      return NextResponse.json(
        {
          error:
            "One or more selected membership types are missing or inactive. Refresh membership types and try again.",
          offenders: error.offenders,
        },
        { status: 422 },
      );
    }
    if (error instanceof XeroDailyLimitError) {
      logger.warn({ err: error }, "Member import hit Xero daily rate limit");
      return NextResponse.json(
        { error: "Xero daily API limit reached. Please try again tomorrow." },
        { status: 429 }
      );
    }
    logger.error({ err: error }, "Member import from Xero failed");
    return NextResponse.json({ error: "Member import failed" }, { status: 500 });
  }
}
