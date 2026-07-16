-- #1938: dedicated, additive notification preference for admin-initiated
-- member delete-request alerts, so muting the shared "Member requests"
-- (adminFamilyGroupRequest) category no longer also silences delete-request
-- alerts. Additive ADD COLUMN DEFAULT true — existing rows keep alerts on.
ALTER TABLE "NotificationPreference" ADD COLUMN     "adminMemberDeleteRequest" BOOLEAN NOT NULL DEFAULT true;
