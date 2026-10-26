/**
 * How a member and a guest are named in bed-allocation admin output (#2688).
 *
 * One canonical pair, because three surfaces need the same wording: the board
 * payload, the inventory guards' refusal messages, and the range assignment's
 * refusal report. `src/lib/member-serialization.ts` carries a same-named
 * `memberName` for the member-directory shapes; the two are not merged here
 * because this is a structural move and that would be a behaviour change.
 */

export function memberName(member: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}) {
  const name = [member.firstName, member.lastName].filter(Boolean).join(" ");
  return name || member.email || "Unknown member";
}

/**
 * A guest's name, or `""` when neither part is known — a stored request's
 * snapshot may lack them (#4088), so both parts are optional here.
 */
export function guestName(guest: { firstName?: string | null; lastName?: string | null }) {
  return [guest.firstName, guest.lastName].filter(Boolean).join(" ");
}
