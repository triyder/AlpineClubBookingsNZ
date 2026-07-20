"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Mail, Phone } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { memberPhotoServingUrl } from "@/lib/member-photo-url";

type CommitteeMember = {
  id: string;
  role: string;
  roleKey?: string;
  name: string;
  phone: string | null;
  contactKey: string | null;
  description: string | null;
  // Present only when the club has opted the roster into photos (MP5, #171) and
  // the member has one.
  photo: { memberId: string; version: string | null } | null;
};

type CommitteePhotoDisplay = "NONE" | "CIRCLE" | "SQUARE";

function memberInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase() || "?";
}

export function CommitteeMembersGrid() {
  const [members, setMembers] = useState<CommitteeMember[]>([]);
  const [photoDisplay, setPhotoDisplay] =
    useState<CommitteePhotoDisplay>("NONE");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/committee")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled) {
          setMembers(data?.members ?? []);
          setPhotoDisplay(
            data?.photoDisplay === "CIRCLE" || data?.photoDisplay === "SQUARE"
              ? data.photoDisplay
              : "NONE",
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMembers([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <p className="text-sm text-brand-deep/70">Loading committee members...</p>
    );
  }

  if (members.length === 0) {
    return (
      <p className="rounded-lg border border-brand-ridge/35 bg-brand-mist/35 p-6 text-brand-deep/75">
        Committee information coming soon.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {members.map((member) => (
        <Card
          key={member.id}
          className="border-brand-ridge/20 bg-brand-snow/90 shadow-[0_20px_45px_-35px_rgba(47,47,43,0.45)]"
        >
          <CardContent className="pt-6">
            {photoDisplay !== "NONE" ? (
              <div
                className={`mb-4 flex h-24 w-24 items-center justify-center overflow-hidden border border-brand-ridge/25 bg-brand-mist/40 text-xl font-semibold text-brand-deep/70 ${
                  photoDisplay === "CIRCLE" ? "rounded-full" : "rounded-lg"
                }`}
                aria-hidden={member.photo ? undefined : true}
              >
                {member.photo ? (
                  // Plain <img>: the scoped serving endpoint is uncacheable by the
                  // image optimiser and gated per member.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={memberPhotoServingUrl(
                      member.photo.memberId,
                      member.photo.version,
                    )}
                    alt={`${member.name}'s photo`}
                    width={96}
                    height={96}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span>{memberInitials(member.name)}</span>
                )}
              </div>
            ) : null}
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-brand-charcoal">
              {member.role}
            </p>
            <h3 className="font-heading text-lg font-semibold text-brand-charcoal">
              {member.name}
            </h3>
            {member.description ? (
              <p className="mt-2 text-sm text-brand-deep/75">
                {member.description}
              </p>
            ) : null}
            <div className="mt-4 flex flex-col gap-2">
              {member.phone ? (
                <a
                  href={`tel:${member.phone.replace(/\s/g, "")}`}
                  className="inline-flex items-center gap-2 text-sm text-brand-deep/78 transition-colors hover:text-brand-charcoal"
                >
                  <Phone className="h-4 w-4 text-brand-gold" />
                  {member.phone}
                </a>
              ) : null}
              {member.contactKey ? (
                <Link
                  href={`/contact?recipient=${encodeURIComponent(member.contactKey)}`}
                  className="inline-flex items-center gap-2 text-sm font-medium text-brand-charcoal underline decoration-brand-gold/70 decoration-2 underline-offset-4 transition-colors hover:text-brand-deep hover:decoration-brand-safety"
                >
                  <Mail className="h-4 w-4 text-brand-gold" />
                  Send a message
                </Link>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
