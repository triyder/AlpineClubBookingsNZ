"use client";

import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";
import type { MemberDetail } from "../_types";

export function MemberXeroContactSummary({ member }: { member: MemberDetail }) {
  return (
    <div className="text-sm">
      <p className="text-muted-foreground">Xero Contact</p>
      <div className="mt-1 space-y-2 font-medium">
        <div>
          {member.xeroContactId ? (
            <a
              href={`https://go.xero.com/Contacts/View/${member.xeroContactId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-blue-600 hover:underline"
            >
              {member.xeroContactId}
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : (
            "Not linked"
          )}
        </div>
        {!member.xeroContactId && (
          <p className="text-xs text-amber-700">
            Membership refresh skips unlinked members. Link or create a Xero
            contact before expecting subscription status to update
            automatically.
          </p>
        )}
        {member.xeroContactGroups.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {member.xeroContactGroups.map((group) => (
              <Badge
                key={group.id}
                variant="secondary"
                className="bg-emerald-50 text-emerald-700 border-emerald-200"
              >
                {group.name}
              </Badge>
            ))}
          </div>
        )}
        {member.xeroContactId && !member.xeroContactGroupsLoaded && (
          <p className="text-xs text-muted-foreground">
            Cached contact groups have not been refreshed yet.
          </p>
        )}
      </div>
    </div>
  );
}
