import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isMemberEligibleToBookLodge } from "@/lib/lodge-access";
import { lodgeOrderBy } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";

// Active lodges a signed-in member may book, for the booking-flow lodge
// selector (phase 8 of docs/multi-lodge/implementation-plan.md). Identity
// fields only — door codes and operational data stay out of this response.
// The client hides the selector when one lodge comes back (ADR-002
// presentation rule); eligibility filtering means a restricted member simply
// never sees lodges they cannot book.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const lodges = await prisma.lodge.findMany({
    where: { active: true },
    orderBy: lodgeOrderBy(),
    select: { id: true, name: true, travelNote: true },
  });

  const eligible = [];
  for (const lodge of lodges) {
    if (
      await isMemberEligibleToBookLodge(prisma, session.user.id, lodge.id)
    ) {
      eligible.push(lodge);
    }
  }

  return NextResponse.json({ lodges: eligible });
}
