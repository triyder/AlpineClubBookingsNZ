"use client";

import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowLeft,
  ExternalLink,
  Link2,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import { accessRoleLabelForToken } from "@/lib/access-role-definitions";
import { useAccessRoleOptions } from "@/hooks/use-access-role-options";
import type { MemberDetail, MemberLifecycleActionRequest } from "../_types";

interface MemberDetailHeaderProps {
  member: MemberDetail;
  backHref: string;
  backLabel: string;
  isAdultMember: boolean;
  memberIsArchived: boolean;
  pendingDeleteRequest: MemberLifecycleActionRequest | undefined;
  /** null = status still loading; no Xero UI renders until it resolves. */
  xeroConnected: boolean | null;
  xeroPushing: boolean;
  xeroUnlinking: boolean;
  onOpenDependentDialog: () => void;
  onOpenLinkXero: () => void;
  onOpenCreateXero: () => void;
  onUnlinkXero: () => void;
}

export function MemberDetailHeader({
  member,
  backHref,
  backLabel,
  isAdultMember,
  memberIsArchived,
  pendingDeleteRequest,
  xeroConnected,
  xeroPushing,
  xeroUnlinking,
  onOpenDependentDialog,
  onOpenLinkXero,
  onOpenCreateXero,
  onUnlinkXero,
}: MemberDetailHeaderProps) {
  const roleOptions = useAccessRoleOptions();
  const router = useRouter();
  const accessRoles = member.accessRoles ?? [];
  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        className="mb-2 -ml-2"
        onClick={() => router.push(backHref)}
      >
        <ArrowLeft className="h-4 w-4 mr-1" /> {backLabel}
      </Button>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-bold text-foreground">
            {member.firstName} {member.lastName}
          </h1>
          <p className="mt-1 break-all text-sm text-muted-foreground">{member.email}</p>
          <div className="flex flex-wrap gap-2 mt-2">
            {accessRoles.length > 0 ? (
              accessRoles.map((role) => (
                <Badge
                  key={role}
                  variant={role.startsWith("ADMIN") ? "default" : "secondary"}
                  className={
                    role.startsWith("ADMIN")
                      ? "bg-primary text-primary-foreground hover:shadow-md"
                      : ""
                  }
                >
                  {accessRoleLabelForToken(role, roleOptions)}
                </Badge>
              ))
            ) : (
              <Badge variant="secondary">No Login</Badge>
            )}
            <Badge
              variant={member.active ? "default" : "destructive"}
              className={
                member.active
                  ? "border-success/20 bg-success-muted text-success hover:shadow-md"
                  : ""
              }
            >
              {member.active ? "Active" : "Inactive"}
            </Badge>
            {member.cancelledAt && (
              <Badge
                variant="secondary"
                className="border-warning/20 bg-warning-muted text-warning"
              >
                Cancelled
              </Badge>
            )}
            {member.archivedAt && (
              <Badge
                variant="secondary"
                className="border-border bg-muted text-foreground"
              >
                Archived
              </Badge>
            )}
            {member.forcePasswordChange && (
              <Badge variant="destructive" className="text-xs">
                PW Reset Required
              </Badge>
            )}
            {pendingDeleteRequest && (
              <Badge variant="destructive" className="text-xs">
                Delete Pending
              </Badge>
            )}
          </div>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
          {isAdultMember && !memberIsArchived && (
            <Button variant="outline" size="sm" onClick={onOpenDependentDialog}>
              <Plus className="h-4 w-4 mr-1" />
              Add Dependent
            </Button>
          )}
          {/* Xero actions render only once the connection status resolves to
              true: everyday actions stay visible, rare ones live in the
              overflow menu. Disconnected (or still loading) shows no Xero UI
              at all — offering link/unlink against a dead connection only
              fails after the click. */}
          {xeroConnected === true &&
            (member.xeroContactId ? (
              <>
                <a
                  href={`https://go.xero.com/Contacts/View/${member.xeroContactId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Button variant="outline" size="sm">
                    <ExternalLink className="h-4 w-4 mr-1" />
                    View in Xero
                  </Button>
                </a>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label="More member actions"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={onOpenLinkXero}>
                      <Link2 className="h-4 w-4 mr-1" />
                      Change Xero Link
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={onUnlinkXero}
                      disabled={xeroUnlinking}
                    >
                      {xeroUnlinking ? "Unlinking..." : "Unlink Xero Contact"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={onOpenLinkXero}>
                  <Link2 className="h-4 w-4 mr-1" />
                  Link to Xero
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label="More member actions"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={onOpenCreateXero}
                      disabled={xeroPushing}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      {xeroPushing ? "Creating..." : "Create in Xero"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ))}
        </div>
      </div>
    </div>
  );
}
