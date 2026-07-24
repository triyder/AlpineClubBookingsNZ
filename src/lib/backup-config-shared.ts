/**
 * Client-safe backup configuration constants (#2227).
 *
 * The canonical backup config module (`backup-config.ts`) imports prisma and
 * must never be pulled into a client bundle (it drags `pg` and Node built-ins
 * into Turbopack's browser graph). The retention bounds are needed by the
 * backup setup wizard's client components, so they live here and are
 * re-exported by `backup-config.ts` — one source of truth, same pattern as
 * `booking-request-shared.ts` / `finance-ratio-shared.ts`.
 */

export const DEFAULT_BACKUP_RETENTION_DAYS = 7;
export const MIN_BACKUP_RETENTION_DAYS = 1;
export const MAX_BACKUP_RETENTION_DAYS = 3650;
