# Schema, Dependencies, Next.js, and CI

**Primary child issue**: #682
**Remediation PR**: #691
**Status**: Closed

## Result

No unresolved critical or high schema, dependency, Next.js, or CI findings remain from this hardening pass.

## Migration Review

The 2026-06-07 migration set reviewed in this pass is:

- `20260607120000_add_bed_allocation_and_internet_banking_modules`
- `20260607130000_add_fixed_nightly_promo_adjustments`
- `20260607133000_add_bed_allocation_inventory`
- `20260607142000_add_bed_allocation_settings`
- `20260607150000_add_payment_source_foundation`
- `20260607164000_add_booking_modification_credit_source`
- `20260607165000_make_booking_modification_credit_unique`

Schema validation passed with Prisma 7.8.0. The follow-up uniqueness migration for `MemberCredit.sourceBookingModificationId` supports idempotent booking-modification account-credit creation and is ordered after the migration that creates the source column.

## Dependency Review

The window included:

- #644 npm minor/patch group update.
- #645 `xero-node` 18 update.

Validation passed:

- `npm audit --audit-level=high --package-lock-only`.
- `npm ci`.
- GitHub dependency-review.
- Full verify job in GitHub Actions.

## Next.js 16 Review

During #682 validation, `next build` warned that Next.js/Turbopack inferred `/home/thatskiff` as the workspace root because that parent directory has a `package-lock.json`.

The versioned Next.js 16 docs in `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/turbopack.md` say `turbopack.root` sets the application root directory and should be an absolute path. PR #691 set:

```ts
turbopack: {
  root: process.cwd(),
}
```

The build warning disappeared on the rerun.

## CI Review

The public repository uses GitHub-hosted Actions:

- Dependency review.
- Semgrep static analysis.
- Gitleaks full repository scan.
- Gitleaks PR diff scan.
- Verify job: install, audit, lint, Prisma generate, tests, build.
- Docker image security: image build plus Trivy CRITICAL gate and HIGH warning scan.
- CodeQL.

PR #691 checks passed, including verify, static analysis, gitleaks, CodeQL, and Docker image security.

## Validation Evidence

Local validation under Node 24/npm 11 included:

- `npm ci`
- `npm audit --audit-level=high --package-lock-only`
- `npm run lint`
- `npm run db:generate`
- `npx prisma validate`
- `npm test`
- `npm run build`
- `git diff --check`

Full test result recorded before this report: 277 files passed, 1 skipped; 2988 tests passed, 1 skipped.

## Schema/CI Conclusion

Schema and lockfile state are valid, dependency audit is clean, local validation passes, and PR #691 CI is green. The final docs PR and post-merge `main` CI must also pass before closing #683 and #674.
