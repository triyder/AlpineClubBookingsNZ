"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import {
  ADMIN_NOTIFICATION_PREFERENCE_KEYS,
  ADMIN_NOTIFICATION_PREFERENCE_META,
  type AdminNotificationPreferenceKey,
  type AdminNotificationPreferences,
} from "@/lib/admin-notification-preferences";

interface AdminNotificationUser {
  id: string;
  name: string;
  email: string;
  preferences: AdminNotificationPreferences;
}

export function AdminNotificationSettings({
  initialAdmins,
}: {
  initialAdmins: AdminNotificationUser[];
}) {
  // Admin notification preferences are a support-area setting; a support:view
  // admin sees the panel read-only (#1940). The PUT route enforces support:edit.
  const canEdit = useAdminAreaEditAccess("support");
  const [admins, setAdmins] = useState(initialAdmins);
  const [savedAdmins, setSavedAdmins] = useState(initialAdmins);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  function handleEdit() {
    setEditing(true);
  }

  function handleCancel() {
    setAdmins(savedAdmins.map((a) => ({ ...a, preferences: { ...a.preferences } })));
    setEditing(false);
  }

  function togglePreference(memberId: string, key: AdminNotificationPreferenceKey) {
    setAdmins((current) =>
      current.map((admin) =>
        admin.id === memberId
          ? {
              ...admin,
              preferences: { ...admin.preferences, [key]: !admin.preferences[key] },
            }
          : admin
      )
    );
  }

  async function handleSave() {
    setSaving(true);

    // Find all changed preferences
    const changes: Array<{ memberId: string; preferences: Partial<AdminNotificationPreferences> }> = [];
    for (const admin of admins) {
      const saved = savedAdmins.find((s) => s.id === admin.id);
      if (!saved) continue;
      const diff: Partial<AdminNotificationPreferences> = {};
      for (const key of ADMIN_NOTIFICATION_PREFERENCE_KEYS) {
        if (admin.preferences[key] !== saved.preferences[key]) {
          diff[key] = admin.preferences[key];
        }
      }
      if (Object.keys(diff).length > 0) {
        changes.push({ memberId: admin.id, preferences: diff });
      }
    }

    if (changes.length === 0) {
      setEditing(false);
      setSaving(false);
      return;
    }

    try {
      // Save each changed admin's preferences
      const results = await Promise.all(
        changes.map(async ({ memberId, preferences }) => {
          const response = await fetch("/api/admin/notifications", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ memberId, preferences }),
          });
          const data = await response.json().catch(() => null);
          if (!response.ok) {
            if (response.status === 403) {
              throw new Error(ADMIN_FORBIDDEN_SAVE_REASON);
            }
            throw new Error(data?.error ?? "Failed to update notification preferences");
          }
          return { memberId, preferences: data.preferences as AdminNotificationPreferences };
        })
      );

      // Update both admins and savedAdmins with server response
      const updatedAdmins = admins.map((admin) => {
        const result = results.find((r) => r.memberId === admin.id);
        return result ? { ...admin, preferences: result.preferences } : admin;
      });
      setAdmins(updatedAdmins);
      setSavedAdmins(updatedAdmins.map((a) => ({ ...a, preferences: { ...a.preferences } })));
      setEditing(false);
    } catch (error) {
      // Revert on error
      setAdmins(savedAdmins.map((a) => ({ ...a, preferences: { ...a.preferences } })));
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to update notification preferences"
      );
    } finally {
      setSaving(false);
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout, and it is
    rendered in BOTH return branches so the region exists from the first paint.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view admin notification preferences but cannot
      change them. Support edit access is required.
    </AdminViewOnlySectionBanner>
  );

  if (admins.length === 0) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="rounded-lg border border-dashed border-border bg-muted px-4 py-6 text-sm text-muted-foreground">
          No active admin users found.
        </div>
      </div>
    );
  }

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div />
        {!editing ? (
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            variant="outline"
            size="sm"
            onClick={handleEdit}
          >
            Edit
          </ViewOnlyActionButton>
        ) : (
          <div className="flex gap-3">
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save Changes"}
            </Button>
            <Button variant="outline" size="sm" onClick={handleCancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {admins.map((admin) => (
          <Card key={admin.id} className="border-border shadow-sm">
            <CardHeader className="pb-4">
              <CardTitle className="text-base">{admin.name}</CardTitle>
              <CardDescription>
                <span>{admin.email}</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {ADMIN_NOTIFICATION_PREFERENCE_KEYS.map((key) => {
                const meta = ADMIN_NOTIFICATION_PREFERENCE_META[key];
                const controlId = `${admin.id}-${key}`;

                return (
                  <div
                    key={key}
                    className="flex items-start gap-3 rounded-lg border border-border p-3"
                  >
                    <Checkbox
                      id={controlId}
                      checked={admin.preferences[key]}
                      disabled={!editing}
                      onCheckedChange={() => editing && togglePreference(admin.id, key)}
                    />
                    <div className="space-y-1">
                      <Label htmlFor={controlId} className="cursor-pointer text-sm font-medium">
                        {meta.label}
                      </Label>
                      <p className="text-xs leading-5 text-muted-foreground">
                        {meta.description}
                      </p>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        ))}
      </div>
      </div>
    </div>
  );
}
