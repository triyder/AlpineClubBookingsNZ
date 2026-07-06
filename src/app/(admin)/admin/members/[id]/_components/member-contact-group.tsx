"use client";

import {
  formatMemberDateNz,
  formatMemberPhone,
  memberUsesSamePostalAddress,
} from "@/lib/admin-member-detail-helpers";
import { formatGenderLabel, formatTitleLabel } from "@/lib/member-enums";
import { useMemberFieldsSettings } from "@/lib/use-member-fields-settings";
import type { MemberDetail } from "../_types";

function addressLines(input: {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}) {
  return [
    input.line1,
    input.line2,
    [input.city, input.region, input.postalCode].filter(Boolean).join(" "),
    input.country,
  ].filter((line): line is string => Boolean(line && line.trim()));
}

function AddressBlock({ lines }: { lines: string[] }) {
  if (lines.length === 0) {
    return <span className="text-xs text-slate-500">Not provided</span>;
  }
  return (
    <span>
      {lines.map((line, index) => (
        <span key={index} className="block">
          {line}
        </span>
      ))}
    </span>
  );
}

export function MemberContactGroup({ member }: { member: MemberDetail }) {
  const { showTitle, showGender, showOccupation } = useMemberFieldsSettings();
  const physicalLines = addressLines({
    line1: member.streetAddressLine1,
    line2: member.streetAddressLine2,
    city: member.streetCity,
    region: member.streetRegion,
    postalCode: member.streetPostalCode,
    country: member.streetCountry,
  });
  const postalSameAsPhysical = memberUsesSamePostalAddress(member);
  const postalLines = addressLines({
    line1: member.postalAddressLine1,
    line2: member.postalAddressLine2,
    city: member.postalCity,
    region: member.postalRegion,
    postalCode: member.postalPostalCode,
    country: member.postalCountry,
  });

  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {showTitle && (
        <div>
          <dt className="text-slate-500">Title</dt>
          <dd className="font-medium">
            {formatTitleLabel(member.title) || "Not set"}
          </dd>
        </div>
      )}
      {showGender && (
        <div>
          <dt className="text-slate-500">Gender</dt>
          <dd className="font-medium">
            {formatGenderLabel(member.gender) || "Not set"}
          </dd>
        </div>
      )}
      <div>
        <dt className="text-slate-500">First Name</dt>
        <dd className="font-medium">{member.firstName}</dd>
      </div>
      <div>
        <dt className="text-slate-500">Last Name</dt>
        <dd className="font-medium">{member.lastName}</dd>
      </div>
      <div>
        <dt className="text-slate-500">Email</dt>
        <dd className="font-medium break-all">{member.email}</dd>
      </div>
      <div>
        <dt className="text-slate-500">Phone</dt>
        <dd className="font-medium">
          {formatMemberPhone(member) || "Not provided"}
        </dd>
      </div>
      <div>
        <dt className="text-slate-500">Date of Birth</dt>
        <dd className="font-medium">
          {member.dateOfBirth
            ? formatMemberDateNz(member.dateOfBirth)
            : "Not set"}
        </dd>
      </div>
      <div>
        <dt className="text-slate-500">Member Since</dt>
        <dd className="font-medium">
          {formatMemberDateNz(member.joinedDate || member.createdAt)}
          {member.joinedDate && (
            <span className="ml-1 text-xs text-slate-400">(from Xero)</span>
          )}
        </dd>
      </div>
      {showOccupation && (
        <div>
          <dt className="text-slate-500">Occupation</dt>
          <dd className="font-medium">{member.occupation || "Not set"}</dd>
        </div>
      )}
      <div>
        <dt className="text-slate-500">Physical Address</dt>
        <dd className="font-medium">
          <AddressBlock lines={physicalLines} />
        </dd>
      </div>
      <div>
        <dt className="text-slate-500">Postal Address</dt>
        <dd className="font-medium">
          {postalSameAsPhysical ? (
            <span className="text-xs text-slate-500">Same as physical</span>
          ) : (
            <AddressBlock lines={postalLines} />
          )}
        </dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="text-slate-500">Comments</dt>
        <dd className="font-medium whitespace-pre-wrap">
          {member.comments || "None"}
        </dd>
      </div>
    </dl>
  );
}
