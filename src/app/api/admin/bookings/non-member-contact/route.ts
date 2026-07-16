import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  createNonMemberContact,
  nonMemberContactCreateSchema,
  NonMemberContactError,
  reuseNonMemberContact,
  suggestNonMemberContacts,
} from "@/lib/non-member-contact";

/**
 * Book-on-behalf non-member booking owner (issue #1935, E9).
 *
 * Gated on `bookings:edit` (owner-approved scope; #1376 precedent made on-behalf
 * endpoints bookings-scoped, and the record is identical to what the public
 * booking-request approval creates without any admin). The whole endpoint —
 * GET (dedupe suggestions) and POST (create / reuse) — requires the same edit
 * permission, so `bookings:view` and membership-only admins are 403.
 *
 *  - GET  ?email=&name=  → suggest existing non-login NON_MEMBER/SCHOOL contacts
 *                          for the officer to pick ("use existing"). Never
 *                          mutates; never forces reuse.
 *  - POST { firstName, lastName, email?, phone?, noEmail? }
 *                        → create a new non-login owner (server-forced role /
 *                          canLogin:false / emailVerified:false / ageTier:ADULT).
 *  - POST { useExistingContactId } → validate + return a picked existing owner.
 */

const BOOKINGS_EDIT = { area: "bookings", level: "edit" } as const;

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({ permission: BOOKINGS_EDIT });
  if (!guard.ok) return guard.response;

  const email = request.nextUrl.searchParams.get("email");
  const name = request.nextUrl.searchParams.get("name");

  const contacts = await suggestNonMemberContacts({ email, name });
  return NextResponse.json({ contacts });
}

const postSchema = z.union([
  z.object({ useExistingContactId: z.string().min(1) }),
  nonMemberContactCreateSchema,
]);

export async function POST(request: NextRequest) {
  const guard = await requireAdmin({ permission: BOOKINGS_EDIT });
  if (!guard.ok) return guard.response;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const parsed = postSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    if ("useExistingContactId" in parsed.data) {
      const contact = await reuseNonMemberContact(
        parsed.data.useExistingContactId
      );
      return NextResponse.json({ contact, reused: true }, { status: 200 });
    }

    const contact = await createNonMemberContact({
      ...parsed.data,
      actorMemberId: guard.session.user.id,
    });
    return NextResponse.json({ contact, reused: false }, { status: 201 });
  } catch (err) {
    if (err instanceof NonMemberContactError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    throw err;
  }
}
