import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { unlinkGoogleAccount } from "@/lib/google-oauth";

// Profile Google account unlink (#2035). Clears `Member.googleSub`, audited
// (security category). Always allowed — every login-capable member retains
// password login, so unlinking never strands anyone.
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  await unlinkGoogleAccount(session.user.id);
  return NextResponse.json({ ok: true });
}
