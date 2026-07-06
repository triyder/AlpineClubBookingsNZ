-- Backfill organisation-type members from the ADULT default to
-- NOT_APPLICABLE (#1440).
--
-- Org-type predicate (stated in the PR): a member holding the ORG access
-- role, or the legacy compatibility role SCHOOL. NON_MEMBER records are
-- deliberately NOT included — they are typically individual booking-request
-- contacts (people, not organisations) and keep their real age tier.
-- Only ADULT rows flip: ADULT is the schema default that mislabelled
-- organisations; any other tier on an org row is operator-entered data the
-- server-side enforcement will normalise on its next update.
UPDATE "Member" m
SET "ageTier" = 'NOT_APPLICABLE'
WHERE m."ageTier" = 'ADULT'
  AND (
    m."role" = 'SCHOOL'
    OR EXISTS (
      SELECT 1
      FROM "MemberAccessRole" r
      WHERE r."memberId" = m."id"
        AND r."role" = 'ORG'
    )
  );
