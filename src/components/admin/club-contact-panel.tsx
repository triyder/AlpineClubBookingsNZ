"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

type Role = { key: string; name: string };

const selectClasses =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Chooses which committee role's member(s) appear in the public Contact page
 * "Club Details" block. Content-area edit gated, like the other panels on this
 * page. The role list comes from GET /api/admin/club-contact so this panel does
 * not need membership-area access.
 */
export function ClubContactPanel() {
  const [roleKey, setRoleKey] = useState<string>("");
  const [roles, setRoles] = useState<Role[]>([]);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const canEdit = useAdminAreaEditAccess("content");
  const viewOnlyReasonId = useId();

  function load() {
    setLoadFailed(false);
    setAccessDenied(false);
    void fetch("/api/admin/club-contact")
      .then(async (response) => {
        if (response.status === 403) {
          setAccessDenied(true);
          return;
        }
        if (!response.ok) throw new Error();
        const data = (await response.json()) as {
          contactCommitteeRoleKey: string | null;
          roles: Role[];
        };
        setRoles(data.roles ?? []);
        setRoleKey(data.contactCommitteeRoleKey ?? "");
        setLoaded(true);
      })
      .catch(() => {
        setLoadFailed(true);
        toast.error("Could not load the club contact setting.");
      });
  }
  useEffect(() => {
    load();
  }, []);

  const viewOnlyBanner = (
    <div id={viewOnlyReasonId}>
      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
        Content view access can inspect this setting. Content edit access is
        required to change it.
      </AdminViewOnlySectionBanner>
    </div>
  );

  if (accessDenied)
    return (
      <p className="text-sm text-muted-foreground">
        Your admin role does not include content access, so the club contact can
        only be changed by an admin with content permissions.
      </p>
    );
  if (loadFailed)
    return (
      <div className="space-y-3">
        <p className="text-sm text-danger">
          Could not load the club contact setting.
        </p>
        <Button variant="outline" onClick={load}>
          Retry
        </Button>
      </div>
    );
  if (!loaded)
    return (
      <div>
        {viewOnlyBanner}
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/admin/club-contact", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactCommitteeRoleKey: roleKey || null }),
      });
      if (!response.ok) throw new Error();
      toast.success("Club contact updated.");
    } catch {
      toast.error("Could not update the club contact.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Choose the committee role whose member(s) are shown in the{" "}
          <strong>Club Details</strong> box on the public{" "}
          <Link href="/contact" className="underline">
            Contact&nbsp;Us
          </Link>{" "}
          page. The published, contactable members holding that role are listed
          there, above the club address. Leave it on the default to keep showing
          the booking officer.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="club-contact-role">Contact role</Label>
          <select
            id="club-contact-role"
            className={selectClasses}
            value={roleKey}
            disabled={!canEdit}
            aria-describedby={!canEdit ? viewOnlyReasonId : undefined}
            onChange={(event) => setRoleKey(event.target.value)}
          >
            <option value="">Default — Booking Officer</option>
            {roles.map((role) => (
              <option key={role.key} value={role.key}>
                {role.name}
              </option>
            ))}
          </select>
          {roles.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No committee roles are set up yet. Add them under Admin → Committee.
            </p>
          )}
        </div>
        <ViewOnlyActionButton
          canEdit={canEdit}
          describeReason={false}
          disabled={saving}
          onClick={save}
        >
          {saving ? "Saving…" : "Save club contact"}
        </ViewOnlyActionButton>
      </div>
    </div>
  );
}
