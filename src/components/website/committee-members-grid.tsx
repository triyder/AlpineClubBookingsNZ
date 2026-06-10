"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Mail, Phone } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

type CommitteeMember = {
  id: string;
  role: string;
  name: string;
  phone: string;
  contactKey: string | null;
  description: string | null;
};

export function CommitteeMembersGrid() {
  const [members, setMembers] = useState<CommitteeMember[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/committee")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled) {
          setMembers(data?.members ?? []);
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
              <a
                href={`tel:${member.phone.replace(/\s/g, "")}`}
                className="inline-flex items-center gap-2 text-sm text-brand-deep/78 transition-colors hover:text-brand-charcoal"
              >
                <Phone className="h-4 w-4 text-brand-gold" />
                {member.phone}
              </a>
              {member.contactKey ? (
                <Link
                  href={`/contact?recipient=${member.contactKey}`}
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
