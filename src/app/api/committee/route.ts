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
  const [assignments, settings] = await Promise.all([
    prisma.committeeAssignment.findMany({
      where: {
        isActive: true,
        published: true,
        committeeRole: { isActive: true },
        member: { active: true },
      },
      orderBy: committeeAssignmentOrderBy(),
      take: 50,
      select: publicCommitteeAssignmentSelect,
    }),
    prisma.publicContentSettings.findUnique({
      where: { id: "default" },
      select: { committeePhotoDisplay: true },
    }),
  ]);

  // MP5 (#171): the club opts the public roster into photos (NONE default). When
  // disabled, no photo metadata is emitted at all.
  const photoDisplay = settings?.committeePhotoDisplay ?? "NONE";
  const includePhoto = photoDisplay !== "NONE";
  const members = assignments.map((assignment) =>
    serializePublicCommitteeAssignment(assignment, { includePhoto }),
  );

  return NextResponse.json({ members, photoDisplay });
}
