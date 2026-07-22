"use client";

import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface XeroSearchResult {
  contactId: string;
  name: string;
  email: string | null;
  isLinked: boolean;
  linkedMemberName: string | null;
  matchReasons?: string[];
  xeroLink?: string;
}

interface XeroSuggestedContactCardProps {
  contact: XeroSearchResult;
  radioName: string;
  checked: boolean;
  onSelect: () => void;
}

/**
 * Single row in the "Review Similar Xero Contacts" suggestion list
 * used by the admin members list and detail pages. Shows the contact
 * name, match reasons, email, linked-member warning, and a "View in
 * Xero" link, with a radio button bound by `radioName` so callers can
 * keep the form group key unique per dialog instance.
 */
export function XeroSuggestedContactCard({
  contact,
  radioName,
  checked,
  onSelect,
}: XeroSuggestedContactCardProps) {
  return (
    <label
      className={`flex items-start gap-3 rounded-md border p-3 ${
        contact.isLinked ? "border-warning-6 bg-warning-3" : "border-border bg-card"
      }`}
    >
      <input
        type="radio"
        name={radioName}
        value={contact.contactId}
        checked={checked}
        onChange={onSelect}
        disabled={contact.isLinked}
        className="mt-1 h-4 w-4 border-border"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-foreground">{contact.name}</p>
          {contact.matchReasons?.map((reason) => (
            <Badge
              key={`${contact.contactId}-${reason}`}
              variant="secondary"
              className="bg-info-3 text-info-11 border-info-6"
            >
              {reason}
            </Badge>
          ))}
        </div>
        {contact.email && <p className="text-xs text-muted-foreground">{contact.email}</p>}
        {contact.isLinked && (
          <p className="text-xs text-warning-11">
            Already linked to {contact.linkedMemberName}
          </p>
        )}
        {contact.xeroLink && (
          <a
            href={contact.xeroLink}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs text-info-11 hover:underline"
          >
            View in Xero
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </label>
  );
}
