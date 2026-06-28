-- Add non-member category roles. These carry NO access — they are neither
-- member-level nor operational — and are used by booking-request flows to mark
-- school groups (SCHOOL) and general public booking contacts (NON_MEMBER) so
-- they are not counted as paying members. IF NOT EXISTS keeps the migration
-- idempotent and re-runnable (Postgres 12+).
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'NON_MEMBER';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SCHOOL';
