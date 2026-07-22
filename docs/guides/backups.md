# Database Backups

Audience: Operator

## What it is

The managed database-backup surface. It configures where nightly PostgreSQL
backups are stored, shows backup status and history, and lets you run a backup on
demand. Find it at **Admin → Integrations → Database Backups**
(`/admin/backups`), or from the **System** section of the admin sidebar.

Since #2095 the backup configuration lives entirely in the app (encrypted in the
`IntegrationCredential` store) — there are no more `BACKUP_*` environment
variables to edit, except `BACKUP_CRON_SCHEDULE`, which sets the nightly run time
in the environment.

> **Text-only guide.** Backups run against the live database, so the
> documentation screenshot harness does not capture this page; it is described in
> prose here.

## When you'd use it

- Setting up durable off-site (S3) backups for the first time.
- Taking a fresh backup immediately before a risky change or an upgrade.
- Checking that the nightly backup is healthy and durable.
- Re-entering S3 credentials after rotating the app auth secret (see
  Troubleshooting).

## Step-by-step

### Configure the destination and credentials (Full Admin)

1. Go to **Admin → Integrations → Database Backups**.
2. In **Credentials (Full Admin only)**, enter the S3 **access key ID** and
   **secret access key**. These are write-only — once saved they are never shown
   again; leave a field blank to keep the current value.
3. In **Configuration → S3 destination**, set the **bucket** and **region**, then
   **Save**. Changing the destination requires Full Admin because repointing it
   would send the whole database dump elsewhere.
4. Turn on **Enable nightly database backups** and set a **retention** window,
   then **Save**.
5. Optionally set a **restore-validation shadow database URL** (Full Admin,
   write-only). When set, each backup is restored into that disposable database
   and smoke-checked. It must NOT point at the live database.

### Run a backup now

1. Confirm **Status** shows **Enabled** and **S3 durable**.
2. Press **Run backup now**. The backup runs in the background (it does not block
   the page); the status and **Recent runs** list update when it finishes. A full
   backup can take several minutes.

## Settings reference

| Setting | Who can change it | Notes |
| --- | --- | --- |
| Enable nightly backups | Support (edit) | Off by default. |
| Retention (days) | Support (edit) | Prunes local files only; set an S3 lifecycle rule for uploaded objects. |
| S3 bucket / region | Full Admin | The destination; format-validated before use. |
| S3 access key ID / secret access key | Full Admin | Write-only, encrypted at rest, never returned. |
| Restore-validation shadow DB URL | Full Admin | Optional; write-only; must differ from the live database. |
| Nightly schedule | Environment (`BACKUP_CRON_SCHEDULE`) | Cron-leader timing; not editable in-app. |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Banner: "credentials could not be decrypted" and backups failing | The app auth secret (`AUTH_SECRET`/`NEXTAUTH_SECRET`) was rotated, so stored credentials can no longer be decrypted | Re-enter the S3 access key/secret on this page (see the auth-secret rotation runbook in [`DEPLOYMENT.md`](../../DEPLOYMENT.md)) |
| Status shows "Local only" / cron records `FAILURE` `backup-not-durable` | No S3 destination configured, so dumps land on ephemeral tmpfs | Set the S3 bucket + credentials (Full Admin) |
| "Run backup now" is disabled | You lack support-edit access, backups are disabled, a run is already in progress, or credentials need re-entry | Resolve the specific condition shown in the status card |
| Warning listing `BACKUP_*` environment variables | Legacy env config is still set but no longer read | Re-enter the values in-app, then remove the variables from the environment |
| "Changing the backup destination requires Full Admin access." | You have support-edit but not Full Admin | A Full Admin must change the bucket/region and credentials |

## Related links

- [`CONFIGURATION.md`](../../CONFIGURATION.md) — environment variables (backups are
  in-app; only `BACKUP_CRON_SCHEDULE` remains).
- [`DEPLOYMENT.md`](../../DEPLOYMENT.md) — backup durability, upgrade re-entry, and
  the run-now/cron cross-process lock.
- [`MAINTENANCE.md`](../MAINTENANCE.md) — the quarterly restore drill.
- [`SECURITY-ATTACK-SURFACE.md`](../SECURITY-ATTACK-SURFACE.md) — the S3 blast
  radius and destination-change privilege.
