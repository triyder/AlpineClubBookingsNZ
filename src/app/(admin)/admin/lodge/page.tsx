"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLodgeOptions } from "@/components/lodge-select";
import { useClubIdentity } from "@/components/club-identity-provider";
import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";

// Multi-lodge kiosks: one shared login per lodge device. Each account can
// bind to a lodge (a MemberLodgeAccess STAFF grant, managed through this
// page's lodge select); an unbound account serves the club's default
// lodge. With fewer than two lodges nothing lodge-related renders and the
// page behaves exactly as the original single-account screen (ADR-002).

interface KioskAccount {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  createdAt: string;
  updatedAt: string;
  boundLodgeId: string | null;
  boundLodgeName: string | null;
}

type SaveMessage = { type: "success" | "error"; text: string } | null;

function AccountCard({
  account,
  lodges,
  showLodgeControls,
  onSaved,
}: {
  account: KioskAccount;
  lodges: Array<{ id: string; name: string }>;
  showLodgeControls: boolean;
  onSaved: () => void;
}) {
  const [email, setEmail] = useState(account.email);
  const [firstName, setFirstName] = useState(account.firstName);
  const [lastName, setLastName] = useState(account.lastName);
  const [password, setPassword] = useState("");
  const [boundLodgeId, setBoundLodgeId] = useState(account.boundLodgeId ?? "");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saveMessage, setSaveMessage] = useState<SaveMessage>(null);

  function handleCancel() {
    setEmail(account.email);
    setFirstName(account.firstName);
    setLastName(account.lastName);
    setBoundLodgeId(account.boundLodgeId ?? "");
    setPassword("");
    setEditing(false);
    setSaveMessage(null);
  }

  async function handleSave() {
    setSaving(true);
    setSaveMessage(null);

    const body: Record<string, unknown> = { id: account.id };
    if (email !== account.email) body.email = email;
    if (firstName !== account.firstName) body.firstName = firstName;
    if (lastName !== account.lastName) body.lastName = lastName;
    if (password) body.password = password;
    if ((account.boundLodgeId ?? "") !== boundLodgeId) {
      body.lodgeId = boundLodgeId || null;
    }

    if (Object.keys(body).length === 1) {
      setSaveMessage({ type: "error", text: "No changes to save" });
      setSaving(false);
      return;
    }

    try {
      const res = await fetch("/api/admin/lodge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setSaveMessage({ type: "error", text: data.error || "Failed to save" });
        return;
      }
      setPassword("");
      setEditing(false);
      setSaveMessage({ type: "success", text: "Kiosk account updated successfully" });
      onSaved();
    } catch {
      setSaveMessage({ type: "error", text: "Failed to save changes" });
    } finally {
      setSaving(false);
    }
  }

  const fieldId = (suffix: string) => `lodge-${account.id}-${suffix}`;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>
          {showLodgeControls
            ? `Kiosk account — ${account.boundLodgeName ?? "Default lodge"}`
            : "Lodge Account Settings"}
        </CardTitle>
        {!editing && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditing(true);
              setSaveMessage(null);
            }}
          >
            Edit
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor={fieldId("first")}>First Name</Label>
            <Input
              id={fieldId("first")}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              disabled={!editing}
              className={!editing ? "bg-slate-50 text-slate-700" : ""}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={fieldId("last")}>Last Name</Label>
            <Input
              id={fieldId("last")}
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              disabled={!editing}
              className={!editing ? "bg-slate-50 text-slate-700" : ""}
            />
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor={fieldId("email")}>Email</Label>
          <Input
            id={fieldId("email")}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={!editing}
            className={!editing ? "bg-slate-50 text-slate-700" : ""}
          />
        </div>

        {showLodgeControls && (
          <div className="space-y-1 max-w-sm">
            <Label htmlFor={fieldId("binding")}>Operates lodge</Label>
            <select
              id={fieldId("binding")}
              value={boundLodgeId}
              onChange={(e) => setBoundLodgeId(e.target.value)}
              disabled={!editing}
              className={`w-full rounded-md border border-input px-3 py-2 text-sm ${!editing ? "bg-slate-50 text-slate-700" : "bg-background"}`}
            >
              <option value="">Default lodge</option>
              {lodges.map((lodge) => (
                <option key={lodge.id} value={lodge.id}>
                  {lodge.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-500">
              The kiosk signed in with this account shows this lodge&apos;s
              guests, roster, and instructions.
            </p>
          </div>
        )}

        {editing && (
          <div className="space-y-1">
            <Label htmlFor={fieldId("password")}>New Password</Label>
            <Input
              id={fieldId("password")}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to keep current password"
            />
            <p className="text-xs text-slate-500">Minimum 6 characters</p>
          </div>
        )}

        <div className="text-xs text-slate-500">
          <p>Created: {new Date(account.createdAt).toLocaleString(APP_LOCALE, { timeZone: APP_TIME_ZONE })}</p>
          <p>Last updated: {new Date(account.updatedAt).toLocaleString(APP_LOCALE, { timeZone: APP_TIME_ZONE })}</p>
        </div>

        {saveMessage && (
          <div
            className={`rounded-md p-3 text-sm ${
              saveMessage.type === "success"
                ? "bg-green-50 text-green-700"
                : "bg-red-50 text-red-700"
            }`}
          >
            {saveMessage.text}
          </div>
        )}

        {editing && (
          <div className="flex gap-3">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save Changes"}
            </Button>
            <Button variant="outline" onClick={handleCancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminLodgePage() {
  const { hutLeaderLabel } = useClubIdentity();
  const [accounts, setAccounts] = useState<KioskAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { lodges } = useLodgeOptions("admin");
  const showLodgeControls = lodges.length > 1;

  // Add-account form (rendered only with a second lodge to point it at).
  const [adding, setAdding] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newLodgeId, setNewLodgeId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState<SaveMessage>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/lodge");
      if (!res.ok) throw new Error("Failed to load lodge account");
      const data = await res.json();
      setAccounts(data.accounts ?? (data.lodge ? [data.lodge] : []));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate() {
    setCreating(true);
    setCreateMessage(null);
    try {
      const res = await fetch("/api/admin/lodge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: newEmail,
          password: newPassword,
          lodgeId: newLodgeId || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCreateMessage({ type: "error", text: data.error || "Failed to create account" });
        return;
      }
      setAdding(false);
      setNewEmail("");
      setNewPassword("");
      setNewLodgeId("");
      setCreateMessage({ type: "success", text: "Kiosk account created" });
      await load();
    } catch {
      setCreateMessage({ type: "error", text: "Failed to create account" });
    } finally {
      setCreating(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Lodge Kiosk</h1>
        <div className="animate-pulse h-64 bg-slate-100 rounded-lg" />
      </div>
    );
  }

  if (error || accounts.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Lodge Kiosk</h1>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          {error || "Lodge account not found. Run the database seed to create it."}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Lodge Kiosk</h1>
        <a
          href="/lodge/kiosk"
          target="_blank"
          rel="noopener noreferrer"
          className="app-button-brand gap-2"
        >
          Preview Kiosk
        </a>
      </div>

      <p className="max-w-3xl text-sm text-slate-600">
        This is the shared sign-in used on the physical lodge kiosk screen — it is
        not a personal admin login. Guests and {hutLeaderLabel.toLowerCase()}s use
        it on the lodge device to check in and out and view lodge information. Set
        the email and
        password below, then sign in once on the kiosk device with these details.
        Use &ldquo;Preview Kiosk&rdquo; above to see exactly what it displays.
        {showLodgeControls &&
          " With more than one lodge, create one kiosk account per lodge and bind each to the lodge its device lives at."}
      </p>

      {accounts.map((account) => (
        <AccountCard
          key={`${account.id}-${account.updatedAt}`}
          account={account}
          lodges={lodges}
          showLodgeControls={showLodgeControls}
          onSaved={() => void load()}
        />
      ))}

      {showLodgeControls && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Add a kiosk account</CardTitle>
            {!adding && (
              <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                Add account
              </Button>
            )}
          </CardHeader>
          {adding && (
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label htmlFor="new-kiosk-email">Email</Label>
                  <Input
                    id="new-kiosk-email"
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-kiosk-password">Password</Label>
                  <Input
                    id="new-kiosk-password"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                  <p className="text-xs text-slate-500">Minimum 6 characters</p>
                </div>
              </div>
              <div className="space-y-1 max-w-sm">
                <Label htmlFor="new-kiosk-lodge">Operates lodge</Label>
                <select
                  id="new-kiosk-lodge"
                  value={newLodgeId}
                  onChange={(e) => setNewLodgeId(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">Default lodge</option>
                  {lodges.map((lodge) => (
                    <option key={lodge.id} value={lodge.id}>
                      {lodge.name}
                    </option>
                  ))}
                </select>
              </div>
              {createMessage && (
                <div
                  className={`rounded-md p-3 text-sm ${
                    createMessage.type === "success"
                      ? "bg-green-50 text-green-700"
                      : "bg-red-50 text-red-700"
                  }`}
                >
                  {createMessage.text}
                </div>
              )}
              <div className="flex gap-3">
                <Button
                  onClick={handleCreate}
                  disabled={creating || !newEmail || newPassword.length < 6}
                >
                  {creating ? "Creating..." : "Create account"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setAdding(false);
                    setCreateMessage(null);
                  }}
                  disabled={creating}
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          )}
          {!adding && createMessage?.type === "success" && (
            <CardContent>
              <div className="rounded-md p-3 text-sm bg-green-50 text-green-700">
                {createMessage.text}
              </div>
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}
