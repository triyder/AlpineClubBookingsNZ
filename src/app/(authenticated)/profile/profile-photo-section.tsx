"use client";

import { MemberPhotoEditor } from "@/components/member-photo-editor";

interface ProfilePhotoSectionProps {
  memberId: string;
  memberName: string;
  initialHasPhoto: boolean;
  initialPhotoVersion: string | null;
}

/**
 * Member self-service profile photo (epic #171, MP3). Thin wrapper over the
 * shared {@link MemberPhotoEditor} in self mode; the member always has edit
 * rights over their own photo.
 */
export function ProfilePhotoSection(props: ProfilePhotoSectionProps) {
  return <MemberPhotoEditor mode="self" canEdit {...props} />;
}
