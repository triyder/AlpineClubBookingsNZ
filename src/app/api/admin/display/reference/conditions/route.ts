import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { buildDisplayState } from "@/lib/lodge-display-state";
import {
  evaluateDisplayCondition,
  listDisplayConditions,
} from "@/lib/lodge-display/conditions";
import { getDefaultLodgeId } from "@/lib/lodges";

// Live conditions status for the LTV-034 Conditions reference (ADR-003 §3): the
// server side of the read-only reference screen. It builds the chosen lodge's
// DisplayState through the SAME privacy-reduced serialiser the wall and the
// admin preview use, then evaluates every registered condition against it and
// returns a plain `{ name, value }` truth vector — the "true right now for this
// lodge" indicator the reference page overlays onto its static registry list.
//
// Read-only: GET-only, admin-guarded, no write on this path (buildDisplayState
// only reads). The conditions registry is a pure function of the payload, so no
// condition can query or mutate. Mirrors the display preview route (LTV-024) for
// lodge resolution — explicit `?lodgeId=…`, else the club default lodge — and,
// like that sibling, applies no per-route rate limit (admin session is the gate).

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const lodgeId =
    req.nextUrl.searchParams.get("lodgeId") ?? (await getDefaultLodgeId(prisma));
  const state = await buildDisplayState(lodgeId);
  if (!state) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }

  const conditions = listDisplayConditions().map((definition) => ({
    name: definition.name,
    value: evaluateDisplayCondition(definition.name, state),
  }));

  return NextResponse.json({
    lodgeId,
    lodgeName: state.lodge.name,
    conditions,
  });
}
