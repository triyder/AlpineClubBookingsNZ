"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  GripVertical,
  Pencil,
  Plus,
  Save,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface LegacyCommitteeMember {
  id: string;
  role: string;
  name: string;
  phone: string;
  email: string | null;
  contactKey: string | null;
  description: string;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CommitteeRole {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  assignmentCount: number;
}

interface CommitteeAssignment {
  id: string;
  memberId: string;
  committeeRoleId: string;
  blurb: string | null;
  sortOrder: number;
  published: boolean;
  showPhone: boolean;
  contactable: boolean;
  isActive: boolean;
  committeeRole: CommitteeRole;
  member: {
    id: string;
    displayName: string;
    email: string;
    phone: string | null;
    role: string;
    active: boolean;
  };
}

const emptyLegacyForm = {
  role: "",
  name: "",
  phone: "",
  email: "",
  contactKey: "",
  description: "",
  sortOrder: 0,
  active: true,
};

const emptyRoleForm = {
  name: "",
  description: "",
  sortOrder: 0,
  isActive: true,
};

const emptyAssignmentForm = {
  blurb: "",
  sortOrder: 0,
  published: false,
  showPhone: false,
  contactable: false,
  isActive: true,
};

async function readJson(response: Response) {
  return response.json().catch(() => null);
}

function responseErrorMessage(body: unknown, fallback: string) {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return fallback;
}

function VisibilityBadge({ visible }: { visible: boolean }) {
  return visible ? (
    <Badge className="border-green-200 bg-green-100 text-green-800">
      <Eye className="mr-1 h-3 w-3" />
      Published
    </Badge>
  ) : (
    <Badge variant="secondary">
      <EyeOff className="mr-1 h-3 w-3" />
      Hidden
    </Badge>
  );
}

export default function CommitteePage() {
  const [legacyMembers, setLegacyMembers] = useState<LegacyCommitteeMember[]>(
    [],
  );
  const [roles, setRoles] = useState<CommitteeRole[]>([]);
  const [assignments, setAssignments] = useState<CommitteeAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [showLegacyForm, setShowLegacyForm] = useState(false);
  const [editingLegacyId, setEditingLegacyId] = useState<string | null>(null);
  const [legacyForm, setLegacyForm] = useState(emptyLegacyForm);

  const [showRoleForm, setShowRoleForm] = useState(false);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [roleForm, setRoleForm] = useState(emptyRoleForm);

  const [editingAssignmentId, setEditingAssignmentId] = useState<string | null>(
    null,
  );
  const [assignmentForm, setAssignmentForm] = useState(emptyAssignmentForm);

  const fetchCommitteeData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [legacyRes, rolesRes, assignmentsRes] = await Promise.all([
        fetch("/api/admin/committee", { credentials: "same-origin" }),
        fetch("/api/admin/committee/roles", { credentials: "same-origin" }),
        fetch("/api/admin/committee/assignments?includeInactive=1", {
          credentials: "same-origin",
        }),
      ]);

      const [legacyBody, rolesBody, assignmentsBody] = await Promise.all([
        readJson(legacyRes),
        readJson(rolesRes),
        readJson(assignmentsRes),
      ]);

      if (!legacyRes.ok) {
        throw new Error(
          responseErrorMessage(legacyBody, "Failed to load committee members"),
        );
      }
      if (!rolesRes.ok) {
        throw new Error(
          responseErrorMessage(rolesBody, "Failed to load committee roles"),
        );
      }
      if (!assignmentsRes.ok) {
        throw new Error(
          responseErrorMessage(
            assignmentsBody,
            "Failed to load committee assignments",
          ),
        );
      }

      setLegacyMembers(legacyBody?.members ?? []);
      setRoles(rolesBody?.roles ?? []);
      setAssignments(assignmentsBody?.assignments ?? []);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load committee data",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchCommitteeData();
  }, [fetchCommitteeData]);

  function openAddLegacyForm() {
    setEditingLegacyId(null);
    const maxOrder = legacyMembers.reduce(
      (max, member) => Math.max(max, member.sortOrder),
      -1,
    );
    setLegacyForm({ ...emptyLegacyForm, sortOrder: maxOrder + 1 });
    setShowLegacyForm(true);
    setError("");
  }

  function openEditLegacyForm(member: LegacyCommitteeMember) {
    setEditingLegacyId(member.id);
    setLegacyForm({
      role: member.role,
      name: member.name,
      phone: member.phone,
      email: member.email ?? "",
      contactKey: member.contactKey ?? "",
      description: member.description,
      sortOrder: member.sortOrder,
      active: member.active,
    });
    setShowLegacyForm(true);
    setError("");
  }

  function closeLegacyForm() {
    setShowLegacyForm(false);
    setEditingLegacyId(null);
    setLegacyForm(emptyLegacyForm);
  }

  function openAddRoleForm() {
    setEditingRoleId(null);
    const maxOrder = roles.reduce(
      (max, role) => Math.max(max, role.sortOrder),
      -1,
    );
    setRoleForm({ ...emptyRoleForm, sortOrder: maxOrder + 1 });
    setShowRoleForm(true);
    setError("");
  }

  function openEditRoleForm(role: CommitteeRole) {
    setEditingRoleId(role.id);
    setRoleForm({
      name: role.name,
      description: role.description ?? "",
      sortOrder: role.sortOrder,
      isActive: role.isActive,
    });
    setShowRoleForm(true);
    setError("");
  }

  function closeRoleForm() {
    setShowRoleForm(false);
    setEditingRoleId(null);
    setRoleForm(emptyRoleForm);
  }

  function openAssignmentForm(assignment: CommitteeAssignment) {
    setEditingAssignmentId(assignment.id);
    setAssignmentForm({
      blurb: assignment.blurb ?? "",
      sortOrder: assignment.sortOrder,
      published: assignment.published,
      showPhone: assignment.showPhone,
      contactable: assignment.contactable,
      isActive: assignment.isActive,
    });
    setError("");
  }

  function closeAssignmentForm() {
    setEditingAssignmentId(null);
    setAssignmentForm(emptyAssignmentForm);
  }

  async function handleLegacySubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);

    const payload = {
      role: legacyForm.role,
      name: legacyForm.name,
      phone: legacyForm.phone,
      email: legacyForm.email || null,
      contactKey: legacyForm.contactKey || null,
      description: legacyForm.description,
      sortOrder: legacyForm.sortOrder,
      active: legacyForm.active,
    };

    try {
      const url = editingLegacyId
        ? `/api/admin/committee/${editingLegacyId}`
        : "/api/admin/committee";
      const response = await fetch(url, {
        method: editingLegacyId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(responseErrorMessage(body, "Failed to save member"));
      }
      closeLegacyForm();
      await fetchCommitteeData();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save member",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleRoleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);

    const payload = {
      name: roleForm.name,
      description: roleForm.description || null,
      sortOrder: roleForm.sortOrder,
      isActive: roleForm.isActive,
    };

    try {
      const url = editingRoleId
        ? `/api/admin/committee/roles/${editingRoleId}`
        : "/api/admin/committee/roles";
      const response = await fetch(url, {
        method: editingRoleId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(responseErrorMessage(body, "Failed to save role"));
      }
      closeRoleForm();
      await fetchCommitteeData();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Failed to save role",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleAssignmentSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingAssignmentId) return;
    setError("");
    setSaving(true);

    try {
      const response = await fetch(
        `/api/admin/committee/assignments/${editingAssignmentId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            blurb: assignmentForm.blurb || null,
            sortOrder: assignmentForm.sortOrder,
            published: assignmentForm.published,
            showPhone: assignmentForm.showPhone,
            contactable: assignmentForm.contactable,
            isActive: assignmentForm.isActive,
          }),
        },
      );
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(
          responseErrorMessage(body, "Failed to save assignment"),
        );
      }
      closeAssignmentForm();
      await fetchCommitteeData();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save assignment",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteLegacy(id: string, name: string) {
    if (!confirm(`Delete committee member "${name}"?`)) return;
    const response = await fetch(`/api/admin/committee/${id}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (response.ok) {
      await fetchCommitteeData();
    }
  }

  async function handleToggleLegacyActive(member: LegacyCommitteeMember) {
    await fetch(`/api/admin/committee/${member.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ active: !member.active }),
    });
    await fetchCommitteeData();
  }

  async function handleReorderLegacy(
    id: string,
    direction: "up" | "down",
  ) {
    const index = legacyMembers.findIndex((member) => member.id === id);
    if (index < 0) return;
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= legacyMembers.length) return;

    const current = legacyMembers[index];
    const swap = legacyMembers[swapIndex];
    await Promise.all([
      fetch(`/api/admin/committee/${current.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ sortOrder: swap.sortOrder }),
      }),
      fetch(`/api/admin/committee/${swap.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ sortOrder: current.sortOrder }),
      }),
    ]);
    await fetchCommitteeData();
  }

  async function handleDeactivateAssignment(assignment: CommitteeAssignment) {
    if (!confirm(`Remove ${assignment.member.displayName} from ${assignment.committeeRole.name}?`)) {
      return;
    }
    const response = await fetch(
      `/api/admin/committee/assignments/${assignment.id}`,
      {
        method: "DELETE",
        credentials: "same-origin",
      },
    );
    if (response.ok) {
      await fetchCommitteeData();
    }
  }

  const activeAssignmentCount = assignments.filter(
    (assignment) => assignment.isActive,
  ).length;
  const publishedAssignmentCount = assignments.filter(
    (assignment) => assignment.isActive && assignment.published,
  ).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Committee</h1>
          <p className="mt-1 text-sm text-slate-500">
            Manage public committee records, master roles, and member-linked
            assignment metadata.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-slate-600">
          <Badge variant="secondary">{roles.length} master roles</Badge>
          <Badge variant="secondary">{activeAssignmentCount} assignments</Badge>
          <Badge variant="secondary">
            {publishedAssignmentCount} marked published
          </Badge>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-lg">Committee Settings</CardTitle>
            <p className="mt-1 text-sm text-slate-500">
              Master roles are reusable positions for member-linked committee
              assignments.
            </p>
          </div>
          <Button onClick={openAddRoleForm}>
            <Plus className="mr-2 h-4 w-4" />
            Add Role
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {showRoleForm ? (
            <form
              onSubmit={handleRoleSubmit}
              className="rounded-md border border-slate-200 p-4"
            >
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-medium text-slate-900">
                  {editingRoleId ? "Edit Role" : "Add Role"}
                </h2>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={closeRoleForm}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="roleName">Role Name *</Label>
                  <Input
                    id="roleName"
                    value={roleForm.name}
                    onChange={(event) =>
                      setRoleForm({ ...roleForm, name: event.target.value })
                    }
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="roleSortOrder">Sort Order</Label>
                  <Input
                    id="roleSortOrder"
                    type="number"
                    min={0}
                    value={roleForm.sortOrder}
                    onChange={(event) =>
                      setRoleForm({
                        ...roleForm,
                        sortOrder: parseInt(event.target.value, 10) || 0,
                      })
                    }
                  />
                </div>
              </div>
              <div className="mt-4">
                <Label htmlFor="roleDescription">Description</Label>
                <Textarea
                  id="roleDescription"
                  rows={3}
                  value={roleForm.description}
                  onChange={(event) =>
                    setRoleForm({
                      ...roleForm,
                      description: event.target.value,
                    })
                  }
                  maxLength={1000}
                />
              </div>
              <label className="mt-4 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={roleForm.isActive}
                  onChange={(event) =>
                    setRoleForm({
                      ...roleForm,
                      isActive: event.target.checked,
                    })
                  }
                  className="h-4 w-4 rounded border-slate-300"
                />
                Active
              </label>
              <div className="mt-4 flex gap-2">
                <Button type="submit" disabled={saving}>
                  <Save className="mr-2 h-4 w-4" />
                  Save Role
                </Button>
                <Button type="button" variant="outline" onClick={closeRoleForm}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : null}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-slate-50">
                  <th className="px-4 py-3 text-left font-medium text-slate-600">
                    Role
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">
                    Key
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">
                    Assignments
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">
                    Status
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-slate-600">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <tr
                    key={role.id}
                    className={`border-b ${role.isActive ? "" : "opacity-60"}`}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">
                        {role.name}
                      </div>
                      {role.description ? (
                        <div className="mt-1 max-w-xl text-xs text-slate-500">
                          {role.description}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-slate-500">{role.key}</td>
                    <td className="px-4 py-3 text-slate-600">
                      {role.assignmentCount}
                    </td>
                    <td className="px-4 py-3">
                      {role.isActive ? (
                        <Badge className="border-green-200 bg-green-100 text-green-800">
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Archived</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEditRoleForm(role)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {roles.length === 0 && !loading ? (
              <div className="p-6 text-center text-sm text-slate-500">
                No committee roles yet.
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Member-Linked Assignments</CardTitle>
          <p className="mt-1 text-sm text-slate-500">
            Assign members from their member detail page. These records do not
            replace the public committee source until the privacy follow-up.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-slate-50">
                  <th className="px-4 py-3 text-left font-medium text-slate-600">
                    Member
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">
                    Role
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">
                    Presentation
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">
                    Status
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-slate-600">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((assignment) => (
                  <tr
                    key={assignment.id}
                    className={`border-b ${
                      assignment.isActive ? "" : "opacity-60"
                    }`}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">
                        {assignment.member.displayName}
                      </div>
                      <div className="text-xs text-slate-500">
                        {assignment.member.email}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-blue-600">
                        {assignment.committeeRole.name}
                      </div>
                      {assignment.blurb ? (
                        <div className="mt-1 max-w-md text-xs text-slate-500">
                          {assignment.blurb}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        <VisibilityBadge visible={assignment.published} />
                        {assignment.showPhone ? (
                          <Badge variant="secondary">Phone allowed</Badge>
                        ) : null}
                        {assignment.contactable ? (
                          <Badge variant="secondary">Contactable</Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {assignment.isActive ? (
                        <Badge className="border-green-200 bg-green-100 text-green-800">
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Inactive</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openAssignmentForm(assignment)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 hover:bg-red-50 hover:text-red-700"
                          onClick={() => handleDeactivateAssignment(assignment)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {assignments.length === 0 && !loading ? (
              <div className="p-6 text-center text-sm text-slate-500">
                No member-linked committee assignments yet.
              </div>
            ) : null}
          </div>

          {editingAssignmentId ? (
            <form
              onSubmit={handleAssignmentSubmit}
              className="rounded-md border border-slate-200 p-4"
            >
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-medium text-slate-900">
                  Edit Assignment
                </h2>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={closeAssignmentForm}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_160px]">
                <div>
                  <Label htmlFor="assignmentBlurb">Blurb</Label>
                  <Textarea
                    id="assignmentBlurb"
                    rows={3}
                    maxLength={1000}
                    value={assignmentForm.blurb}
                    onChange={(event) =>
                      setAssignmentForm({
                        ...assignmentForm,
                        blurb: event.target.value,
                      })
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="assignmentSortOrder">Sort Order</Label>
                  <Input
                    id="assignmentSortOrder"
                    type="number"
                    min={0}
                    value={assignmentForm.sortOrder}
                    onChange={(event) =>
                      setAssignmentForm({
                        ...assignmentForm,
                        sortOrder: parseInt(event.target.value, 10) || 0,
                      })
                    }
                  />
                </div>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-4">
                {[
                  ["published", "Published"],
                  ["showPhone", "Show phone"],
                  ["contactable", "Contactable"],
                  ["isActive", "Active"],
                ].map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={
                        assignmentForm[key as keyof typeof assignmentForm] as boolean
                      }
                      onChange={(event) =>
                        setAssignmentForm({
                          ...assignmentForm,
                          [key]: event.target.checked,
                        })
                      }
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="mt-4 flex gap-2">
                <Button type="submit" disabled={saving}>
                  <Save className="mr-2 h-4 w-4" />
                  Save Assignment
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeAssignmentForm}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-lg">Legacy Public Committee</CardTitle>
            <p className="mt-1 text-sm text-slate-500">
              These records still power the public committee page and contact
              recipient list.
            </p>
          </div>
          <Button onClick={openAddLegacyForm}>
            <Plus className="mr-2 h-4 w-4" />
            Add Public Entry
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {showLegacyForm ? (
            <form
              onSubmit={handleLegacySubmit}
              className="rounded-md border border-slate-200 p-4"
            >
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-medium text-slate-900">
                  {editingLegacyId
                    ? "Edit Public Committee Entry"
                    : "Add Public Committee Entry"}
                </h2>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={closeLegacyForm}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="legacyRole">Role / Position *</Label>
                  <Input
                    id="legacyRole"
                    value={legacyForm.role}
                    onChange={(event) =>
                      setLegacyForm({ ...legacyForm, role: event.target.value })
                    }
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="legacyName">Name *</Label>
                  <Input
                    id="legacyName"
                    value={legacyForm.name}
                    onChange={(event) =>
                      setLegacyForm({ ...legacyForm, name: event.target.value })
                    }
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="legacyPhone">Phone *</Label>
                  <Input
                    id="legacyPhone"
                    value={legacyForm.phone}
                    onChange={(event) =>
                      setLegacyForm({
                        ...legacyForm,
                        phone: event.target.value,
                      })
                    }
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="legacyEmail">Email</Label>
                  <Input
                    id="legacyEmail"
                    type="email"
                    value={legacyForm.email}
                    onChange={(event) =>
                      setLegacyForm({
                        ...legacyForm,
                        email: event.target.value,
                      })
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="legacyContactKey">Contact Key</Label>
                  <Input
                    id="legacyContactKey"
                    value={legacyForm.contactKey}
                    onChange={(event) =>
                      setLegacyForm({
                        ...legacyForm,
                        contactKey: event.target.value,
                      })
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="legacySortOrder">Display Order</Label>
                  <Input
                    id="legacySortOrder"
                    type="number"
                    min={0}
                    value={legacyForm.sortOrder}
                    onChange={(event) =>
                      setLegacyForm({
                        ...legacyForm,
                        sortOrder: parseInt(event.target.value, 10) || 0,
                      })
                    }
                  />
                </div>
              </div>
              <div className="mt-4">
                <Label htmlFor="legacyDescription">Description *</Label>
                <Textarea
                  id="legacyDescription"
                  rows={3}
                  value={legacyForm.description}
                  onChange={(event) =>
                    setLegacyForm({
                      ...legacyForm,
                      description: event.target.value,
                    })
                  }
                  required
                  maxLength={500}
                />
              </div>
              <label className="mt-4 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={legacyForm.active}
                  onChange={(event) =>
                    setLegacyForm({
                      ...legacyForm,
                      active: event.target.checked,
                    })
                  }
                  className="h-4 w-4 rounded border-slate-300"
                />
                Active on public committee page
              </label>
              <div className="mt-4 flex gap-2">
                <Button type="submit" disabled={saving}>
                  <Save className="mr-2 h-4 w-4" />
                  Save Public Entry
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeLegacyForm}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : null}

          {loading ? (
            <div className="p-6 text-center text-sm text-slate-500">
              Loading...
            </div>
          ) : legacyMembers.length === 0 ? (
            <div className="p-6 text-center text-slate-500">
              <Users className="mx-auto mb-2 h-8 w-8 text-slate-300" />
              <p>No public committee entries yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-slate-50">
                    <th className="w-10 px-4 py-3 text-left font-medium text-slate-600">
                      #
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">
                      Role
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">
                      Name
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">
                      Phone
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">
                      Status
                    </th>
                    <th className="px-4 py-3 text-right font-medium text-slate-600">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {legacyMembers.map((member, index) => (
                    <tr
                      key={member.id}
                      className={`border-b hover:bg-slate-50 ${
                        member.active ? "" : "opacity-60"
                      }`}
                    >
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-0.5">
                          <button
                            onClick={() =>
                              handleReorderLegacy(member.id, "up")
                            }
                            disabled={index === 0}
                            className="text-slate-400 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-30"
                            title="Move up"
                          >
                            <ArrowUp className="h-3 w-3" />
                          </button>
                          <GripVertical className="mx-auto h-3 w-3 text-slate-300" />
                          <button
                            onClick={() =>
                              handleReorderLegacy(member.id, "down")
                            }
                            disabled={index === legacyMembers.length - 1}
                            className="text-slate-400 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-30"
                            title="Move down"
                          >
                            <ArrowDown className="h-3 w-3" />
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-medium text-blue-600">
                          {member.role}
                        </span>
                        {member.contactKey ? (
                          <p className="mt-0.5 text-xs text-slate-400">
                            key: {member.contactKey}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{member.name}</div>
                        {member.email ? (
                          <div className="text-xs text-slate-500">
                            {member.email}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {member.phone}
                      </td>
                      <td className="px-4 py-3">
                        <button onClick={() => handleToggleLegacyActive(member)}>
                          {member.active ? (
                            <Badge className="cursor-pointer border-green-200 bg-green-100 text-green-800">
                              Active
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="cursor-pointer">
                              Inactive
                            </Badge>
                          )}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEditLegacyForm(member)}
                            className="text-slate-600 hover:text-blue-600"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              handleDeleteLegacy(member.id, member.name)
                            }
                            className="text-red-600 hover:bg-red-50 hover:text-red-700"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
