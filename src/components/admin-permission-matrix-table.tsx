"use client";

import {
  ADMIN_PERMISSION_AREAS,
  type AdminPermissionLevel,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { cn } from "@/lib/utils";

const LEVEL_LABELS: Record<AdminPermissionLevel, string> = {
  none: "None",
  view: "View",
  edit: "Edit",
};

const LEVEL_CLASSES: Record<AdminPermissionLevel, string> = {
  none: "border-slate-200 bg-slate-50 text-slate-500",
  view: "border-blue-200 bg-blue-50 text-blue-700",
  edit: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

export function AdminPermissionLevelBadge({
  level,
}: {
  level: AdminPermissionLevel;
}) {
  return (
    <span
      className={cn(
        "self-center rounded-full border px-2 py-0.5 text-xs font-semibold",
        LEVEL_CLASSES[level],
      )}
    >
      {LEVEL_LABELS[level]}
    </span>
  );
}

/** Read-only per-area permission table used by the access-role picker and the role manager. */
export function AdminPermissionMatrixTable({
  matrix,
}: {
  matrix: AdminPermissionMatrix;
}) {
  return (
    <div className="rounded-md border border-slate-200">
      <div className="grid grid-cols-[1fr_auto] gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase text-slate-500">
        <span>Admin Area</span>
        <span>Access</span>
      </div>
      <div className="divide-y divide-slate-200">
        {ADMIN_PERMISSION_AREAS.map((area) => (
          <div
            key={area.key}
            className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2"
          >
            <div>
              <div className="text-sm font-medium text-slate-900">
                {area.label}
              </div>
              <div className="text-xs text-muted-foreground">
                {area.description}
              </div>
            </div>
            <AdminPermissionLevelBadge level={matrix[area.key]} />
          </div>
        ))}
      </div>
    </div>
  );
}
