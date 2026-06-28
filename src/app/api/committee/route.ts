import { NextResponse } from "next/server";
import {
  committeeAssignmentOrderBy,
  publicCommitteeAssignmentSelect,
  serializePublicCommitteeAssignment,
} from "@/lib/committee";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/committee
 * Public endpoint: returns published committee assignments with server-curated
 * contact metadata. Member email addresses are never selected or returned.
 */
export async function GET() {
  const assignments = await prisma.committeeAssignment.findMany({
    where: {
      isActive: true,
      published: true,
      committeeRole: { isActive: true },
      member: { active: true },
    },
    orderBy: committeeAssignmentOrderBy(),
    take: 50,
    select: publicCommitteeAssignmentSelect,
  });

  const members = assignments.map(serializePublicCommitteeAssignment);

  return NextResponse.json({ members });
}
