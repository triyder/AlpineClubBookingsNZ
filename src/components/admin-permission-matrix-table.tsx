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
  none: "border-border bg-muted text-muted-foreground",
  view: "border-info-6 bg-info-3 text-info-11",
  edit: "border-success-6 bg-success-3 text-success-11",
};

function AdminPermissionLevelBadge({
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
    <div className="rounded-md border border-border">
      <div className="grid grid-cols-[1fr_auto] gap-2 border-b border-border bg-muted px-3 py-2 text-xs font-semibold uppercase text-muted-foreground">
        <span>Admin Area</span>
        <span>Access</span>
      </div>
      <div className="divide-y divide-border">
        {ADMIN_PERMISSION_AREAS.map((area) => (
          <div
            key={area.key}
            className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2"
          >
            <div>
              <div className="text-sm font-medium text-foreground">
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
