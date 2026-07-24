# Database Backups

Audience: Operator

## What it is

The managed database-backup surface. It configures where nightly PostgreSQL
backups are stored, shows backup status and history, and lets you run a backup on
demand.

There are two ways in:

- **Guided setup wizard** (`/admin/backups/setup`) — the **Database Backups** card
  on **Admin → Integrations** opens this. It walks first-time setup step by step
  (S3 credentials → destination → turn on nightly backups → a real verification
  run) with the same guided experience as Stripe, Xero and Google sign-in, and
  will not let you jump ahead until each step is done.
- **Flat backups page** (`/admin/backups`, also under the **System** section of
  the admin sidebar) — the post-setup editing surface: status, configuration,
  credentials, and run history all on one page.

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

### First-time setup with the wizard (recommended)

Open **Admin → Integrations → Database Backups** to start the guided wizard. It
has four steps and gates each one until it is satisfied:

1. **S3 credentials** (Full Admin) — enter the S3 **access key ID** and **secret
   access key**. Both are write-only: once saved they are never shown again.
2. **Destination** (Full Admin) — enter the **bucket** and **region**. Repointing
   the destination sends the whole database dump elsewhere, so it is Full-Admin
   only.
3. **Turn it on** (Support edit) — switch on **nightly database backups** and set
   a **retention** window.
4. **Verify** (Support edit) — press **Run verification backup**. This runs a real
   `pg_dump` now, uploads it to S3, and reads it back. When it succeeds you get a
   **Verified** badge showing the uploaded object's S3 key and size — proof the
   whole path works end to end.

If a deployment still has legacy `BACKUP_*` environment variables set, step 1
shows a migration callout naming the values to re-enter (bucket, region, access
key ID, secret access key) and listing the variables to remove afterwards.

After setup, use the flat **Database Backups** page (`/admin/backups`) for
ongoing configuration, credential rotation, and run history.

### Configure the destination and credentials (Full Admin)

The flat page exposes the same settings without the step gating, for edits after
initial setup:

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
