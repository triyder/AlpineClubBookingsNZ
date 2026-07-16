"use client";

import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

type Lodge = {
  id: string;
  name: string;
  address: string | null;
  travelNote: string | null;
  doorCode: string | null;
};

// Single-lodge editing surface (E3 #1929). Multi-lodge clubs manage lodges under
// Admin > Setup > Lodges; this card only appears for a single-lodge club.
export function LodgeDetailsPanel() {
  const [lodge, setLodge] = useState<Lodge | null>(null);
  const [multiLodge, setMultiLodge] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // A content-only admin can reach the Club Identity page but has no lodge:view;
  // GET /api/admin/lodges then 403s. Distinguish that from a transient failure so
  // we can explain the missing card rather than show a raw error + Retry.
  const [accessDenied, setAccessDenied] = useState(false);
  // Gated on the "lodge" area (E1's view-only pattern, area-generic): the save
  // hits the lodge-area /api/admin/lodges/[id] route, so the UI gate must match.
  const canEdit = useAdminAreaEditAccess("lodge");
  const viewOnlyReasonId = useId();

  function load() {
    setLoadFailed(false);
    setAccessDenied(false);
    void fetch("/api/admin/lodges")
      .then(async (response) => {
        // A cross-area denial (content-only admin without lodge:view) is not a
        // failure — render a read-only explanation instead of an error + Retry.
        if (response.status === 403) {
          setAccessDenied(true);
          return;
        }
        if (!response.ok) throw new Error();
        const lodges: Lodge[] = (await response.json()).lodges ?? [];
        if (lodges.length === 1) {
          setLodge(lodges[0]);
          setMultiLodge(false);
        } else {
          setLodge(null);
          setMultiLodge(true);
        }
      })
      .catch(() => {
        setLoadFailed(true);
        toast.error("Could not load lodge details.");
      });
  }
  useEffect(() => {
    load();
  }, []);

  if (accessDenied)
    return (
      <p className="text-sm text-muted-foreground">
        Your admin role does not include lodge access, so lodge details can only
        be viewed and edited by an admin with lodge permissions.
      </p>
    );
  if (loadFailed)
    return (
      <div className="space-y-3">
        <p className="text-sm text-danger">Could not load lodge details.</p>
        <Button variant="outline" onClick={load}>
          Retry
        </Button>
      </div>
    );
  if (multiLodge)
    return (
      <p className="text-sm text-muted-foreground">
        This club has more than one lodge. Manage each lodge&apos;s name,
        address, travel note, and door code under Admin &gt; Setup &gt; Lodges.
      </p>
    );
  if (!lodge)
    return (
      <p className="text-sm text-muted-foreground">Loading lodge details…</p>
    );

  async function save() {
    if (!lodge) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/admin/lodges/${lodge.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: lodge.name.trim(),
          address: lodge.address ?? null,
          travelNote: lodge.travelNote ?? null,
          doorCode: lodge.doorCode ?? null,
        }),
      });
      if (!response.ok) throw new Error();
      setLodge((await response.json()).lodge);
      toast.success("Lodge details updated.");
    } catch {
      toast.error("Could not update lodge details.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        The lodge name and address appear on the public site (contact page and
        the {"{{lodge-name}}"} / {"{{lodge-address}}"} content tokens). The door
        code is only shared in confirmation emails.
      </p>
      {!canEdit ? (
        <div id={viewOnlyReasonId}>
          <AdminViewOnlyNotice>
            Lodge view access can inspect lodge details. Lodge edit access is
            required to change them.
          </AdminViewOnlyNotice>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="lodge-details-name">Lodge name</Label>
        <Input
          id="lodge-details-name"
          value={lodge.name}
          disabled={!canEdit}
          aria-describedby={!canEdit ? viewOnlyReasonId : undefined}
          onChange={(event) => setLodge({ ...lodge, name: event.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="lodge-details-address">Address</Label>
        <Textarea
          id="lodge-details-address"
          value={lodge.address ?? ""}
          rows={2}
          placeholder="Optional — shown on the public contact page when set"
          disabled={!canEdit}
          aria-describedby={!canEdit ? viewOnlyReasonId : undefined}
          onChange={(event) =>
            setLodge({ ...lodge, address: event.target.value })
          }
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="lodge-details-travel">Travel note</Label>
        <Textarea
          id="lodge-details-travel"
          value={lodge.travelNote ?? ""}
          rows={2}
          disabled={!canEdit}
          aria-describedby={!canEdit ? viewOnlyReasonId : undefined}
          onChange={(event) =>
            setLodge({ ...lodge, travelNote: event.target.value })
          }
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="lodge-details-door">Door code</Label>
        <Input
          id="lodge-details-door"
          value={lodge.doorCode ?? ""}
          disabled={!canEdit}
          aria-describedby={!canEdit ? viewOnlyReasonId : undefined}
          onChange={(event) =>
            setLodge({ ...lodge, doorCode: event.target.value })
          }
        />
      </div>
      <ViewOnlyActionButton canEdit={canEdit} disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Save lodge details"}
      </ViewOnlyActionButton>
    </div>
  );
}
