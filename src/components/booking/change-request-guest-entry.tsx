"use client";

import type { AgeTier } from "@prisma/client";
import { useState, type ComponentType } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AddedGuestRow } from "@/components/edit-booking/added-guest-row";
import {
  MemberGuestFindPanel,
  type MemberGuestFindEndpoints,
} from "@/components/book/member-guest-find-panel";
import type { FamilyMember, NewGuest } from "@/components/edit-booking/types";
import type { AgeTierOption } from "@/lib/use-age-tier-options";
import type { MemberGuestCandidate } from "@/lib/member-guest-find";
import type {
  ChangeRequestAddGuest,
  ChangeRequestStay,
} from "@/lib/booking-change-request-guests";

/**
 * Who a locked-period change request adds (#4030), entered with the guest
 * editor's own fields: a name and age tier for somebody who is not a member, a
 * member found through the member-guest finder (or, for the booker, one of
 * their own family), and each person's nights inside the stay.
 *
 * ONE COMPONENT FOR BOTH ENDS OF THE QUEUE. The member's in-progress "Admin
 * Request" card uses it to say who they are asking to add (Part A); the
 * officer's finished-stay approval card uses it to enter the guests a
 * free-text request described (Part B). The rows are the guest editor's own
 * `AddedGuestRow`, with its Date In / Date Out bounded to the stay, so a guest
 * looks and is bounded the same way on all three surfaces.
 *
 * Presentational: the list lives with the caller, which owns what is sent.
 * Every rule is the server's — this only stops a name being added blank.
 */
export function ChangeRequestGuestEntry({
  idPrefix,
  guests,
  onChange,
  ageTierOptions,
  stay,
  existingMemberIds,
  familyMembers = [],
  memberFind,
  disabled = false,
  stayStartMax,
  ActionButton = Button,
  inputTitle,
}: {
  /** Distinguishes this entry's field ids from any other on the page. */
  idPrefix: string;
  guests: NewGuest[];
  onChange: (guests: NewGuest[]) => void;
  ageTierOptions: AgeTierOption[];
  stay: ChangeRequestStay;
  /** Members already on the booking, so the finder disables rather than hides them. */
  existingMemberIds: readonly string[];
  /** The booker's own family, offered as one-click adds (member side only). */
  familyMembers?: readonly FamilyMember[];
  /** The member-guest finder, when the club's module offers it to this viewer. */
  memberFind?: { openSearchEnabled: boolean; endpoints?: MemberGuestFindEndpoints } | null;
  disabled?: boolean;
  /**
   * #4030 review S3: the latest night a guest may start on — the last night
   * the member can no longer book themselves — so the card never prices an add
   * the request would then refuse as an ordinary edit.
   */
  stayStartMax?: string;
  /**
   * #4030 review S6: the button the entry renders. The officer's card passes
   * its view-only button, so a view-only admin sees the queue's own disabled
   * pattern; the member card keeps the plain one.
   */
  ActionButton?: ComponentType<ButtonProps>;
  /** #4030 review S6: the explanation a disabled field carries (the officer's view-only reason). */
  inputTitle?: string;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [ageTier, setAgeTier] = useState<AgeTier>("ADULT");
  const [finderOpen, setFinderOpen] = useState(false);

  const memberIdsInParty = [
    ...existingMemberIds,
    ...guests.flatMap((guest) => (guest.memberId ? [guest.memberId] : [])),
  ];
  const add = (guest: Omit<NewGuest, "key" | "stayStart" | "stayEnd">) =>
    onChange([
      ...guests,
      { ...guest, key: crypto.randomUUID(), stayStart: stay.checkIn, stayEnd: stay.checkOut },
    ]);
  const addMember = (member: { memberId: string; firstName: string; lastName: string; ageTier: AgeTier }) => {
    if (memberIdsInParty.includes(member.memberId)) return;
    add({
      firstName: member.firstName,
      lastName: member.lastName,
      ageTier: member.ageTier,
      isMember: true,
      memberId: member.memberId,
    });
  };
  const addNonMember = () => {
    if (!firstName.trim() || !lastName.trim()) return;
    add({ firstName: firstName.trim(), lastName: lastName.trim(), ageTier, isMember: false });
    setFirstName("");
    setLastName("");
  };
  const updateRange = (key: string, field: "stayStart" | "stayEnd", value: string) =>
    onChange(guests.map((guest) => (guest.key === key ? { ...guest, [field]: value } : guest)));

  const quickAdds = familyMembers.filter((member) => !memberIdsInParty.includes(member.id));

  return (
    <div className="space-y-3">
      {guests.length > 0 ? (
        <div className="space-y-1" role="group" aria-label="Guests to add">
          {guests.map((guest) => (
            <AddedGuestRow
              key={guest.key}
              guest={guest}
              ageTierOptions={ageTierOptions}
              perGuestDatesEnabled
              checkIn={stay.checkIn}
              checkOut={stay.checkOut}
              stayStartMax={stayStartMax}
              onUpdateRange={(field, value) => updateRange(guest.key, field, value)}
              onRemove={() => onChange(guests.filter((other) => other.key !== guest.key))}
            />
          ))}
        </div>
      ) : null}

      {quickAdds.length > 0 ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Add a family member">
          {quickAdds.map((member) => (
            <ActionButton
              key={member.id}
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => addMember({ ...member, memberId: member.id })}
            >
              + {member.firstName} {member.lastName}
            </ActionButton>
          ))}
        </div>
      ) : null}

      {memberFind ? (
        finderOpen ? (
          <MemberGuestFindPanel
            openSearchEnabled={memberFind.openSearchEnabled}
            endpoints={memberFind.endpoints}
            existingMemberIds={memberIdsInParty}
            atCapacity={false}
            onAdd={(candidate: MemberGuestCandidate) => {
              addMember(candidate);
              setFinderOpen(false);
            }}
            onCancel={() => setFinderOpen(false)}
          />
        ) : (
          <ActionButton
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setFinderOpen(true)}
          >
            + Add a member
          </ActionButton>
        )
      ) : null}

      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-first-name`}>First name</Label>
          <Input
            id={`${idPrefix}-first-name`}
            value={firstName}
            disabled={disabled}
            title={disabled ? inputTitle : undefined}
            maxLength={100}
            onChange={(event) => setFirstName(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-last-name`}>Last name</Label>
          <Input
            id={`${idPrefix}-last-name`}
            value={lastName}
            disabled={disabled}
            title={disabled ? inputTitle : undefined}
            maxLength={100}
            onChange={(event) => setLastName(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-age-tier`}>Age</Label>
          <select
            id={`${idPrefix}-age-tier`}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={ageTier}
            disabled={disabled}
            title={disabled ? inputTitle : undefined}
            onChange={(event) => setAgeTier(event.target.value as AgeTier)}
          >
            {ageTierOptions.map((option) => (
              <option key={option.tier} value={option.tier}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <ActionButton
          type="button"
          variant="outline"
          disabled={disabled || !firstName.trim() || !lastName.trim()}
          onClick={addNonMember}
        >
          Add guest
        </ActionButton>
      </div>
    </div>
  );
}

/**
 * The entered rows as the request carries them: every guest with explicit
 * nights (the row shows the stay's bounds until changed, so that is what was
 * on screen), and a member id only for a member.
 */
export function changeRequestGuestsPayload(
  guests: readonly NewGuest[],
  stay: ChangeRequestStay,
): Array<ChangeRequestAddGuest & { stayStart: string; stayEnd: string }> {
  return guests.map((guest) => ({
    firstName: guest.firstName,
    lastName: guest.lastName,
    ageTier: guest.ageTier as ChangeRequestAddGuest["ageTier"],
    isMember: guest.isMember,
    ...(guest.isMember && guest.memberId ? { memberId: guest.memberId } : {}),
    stayStart: guest.stayStart ?? stay.checkIn,
    stayEnd: guest.stayEnd ?? stay.checkOut,
  }));
}
