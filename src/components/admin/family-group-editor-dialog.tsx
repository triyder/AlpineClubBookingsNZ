"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FamilyGroupEditor } from "@/components/admin/family-group-editor";

interface FamilyGroupEditorDialogProps {
  groupId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
  // Tri-state (#2065): `undefined` while the session resolves (neutral disabled).
  canEdit: boolean | undefined;
}

export function FamilyGroupEditorDialog({
  groupId,
  open,
  onOpenChange,
  onChanged,
  canEdit,
}: FamilyGroupEditorDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Family Group Editor</DialogTitle>
          <DialogDescription>
            Manage members, pending requests, and shared-email login ownership.
          </DialogDescription>
        </DialogHeader>
        {groupId && (
          <FamilyGroupEditor
            groupId={groupId}
            onClose={() => onOpenChange(false)}
            onChanged={onChanged}
            canEdit={canEdit}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
