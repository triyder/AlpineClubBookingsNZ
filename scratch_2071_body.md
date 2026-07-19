## Linked Issue

- Closes #2069 (parent epic #2066, production review finding 8)

## Summary

- Adds an explicit "N/A (no age)" (`NOT_APPLICABLE`) checkbox to the membership-type editor's allowed-age-tier list, sorted last, per the owner's binding decisions on #2069: explicit opt-in checkbox, ≥1-selection validation kept, new-type drafts still pre-check only the four age tiers.
- `MEMBERSHIP_TYPE_AGE_TIERS` (feeds the zod enums, normaliser, and checkbox list) now includes `NOT_APPLICABLE`; a new `DEFAULT_MEMBERSHIP_TYPE_AGE_TIERS` (the four age tiers) drives the create-route omitted-`allowedAgeTiers` default so the API default does NOT gain N/A.
- Merge guard already skips `NOT_APPLICABLE` members; added test coverage that real-age members are still blocked from merging into an N/A-only target. No guard logic changed.
- Built-in type seeds and `ageGroupsApply` untouched.

## Risk Level

- [x] Medium

## Changed Areas

- [x] Membership/family lifecycle
- [x] Admin/finance/lodge UI

## Tests Added Or Updated

- Membership-types route tests: create/update accepting `NOT_APPLICABLE` (incl. PATCH to N/A-only); omitted `allowedAgeTiers` still defaults to the four age tiers.
- Membership-types page test: "N/A (no age)" checkbox offered, not pre-checked; zero-ticked still blocked.
- Merge-guard test: real-age members blocked from an N/A-only target; N/A members merge cleanly.

## Validation Commands Run

```bash
npm run db:generate
npm run lint
npm run typecheck
npm test -- <targeted membership-types suites>   # all green
```

## Commands Not Run And Why

- Full `npm test` + `npm run build` are running now via the orchestrator gate; results will be posted in the merge-ready comment before this PR leaves draft.

## Screenshots Or UI Evidence

- Checkbox-list change to the existing membership-type dialog; covered by page tests asserting the "N/A (no age)" option renders, is not pre-checked, and zero-selection stays blocked.

## Security And Privacy Impact

- None. Admin-gated editor; no new endpoints, no auth changes.

## Data Integrity Impact

- `allowedAgeTiers` may now contain `NOT_APPLICABLE`; the only functional consumer (merge guard) already handled it. ≥1 validation retained client + server.

## Concurrency And Lock Impact

- Writer class(es), canonical lock key(s), and acquisition order: admin membership-type config writer only � create/PATCH rewrite `MembershipTypeAgeTier` rows inside the existing single Prisma transaction per request; no booking/capacity/settlement/credit writer touched; no advisory locks involved (unchanged from main).
- Immutable pre-lock key source and mutable under-lock re-read: N/A for this diff � the touched writers key on the immutable membership-type id from the URL/body; the merge route's guarded flow is unchanged (comment-only edit there).
- Status-guarded claim and proof that a lost claim runs no side effect: unchanged � the merge route's existing guard/409 flow is untouched by this diff (comment + tests only); config create/PATCH have no claim semantics (last-write-wins admin config, as on main).
- Relevant open/last-10 PR numbers, counterpart writers/tests, and compatibility evidence: open PRs #2063/#2064 are docs-only and #2070 (dependabot codeql-action bump) does not touch membership-type tier config; counterpart merge-guard writer tests extended in this PR and green; last-10 merged PRs (#2043, #2042 area) touch auth/validators, not `allowedAgeTiers`.
- Provider calls inside a transaction (write `None`, or justify the bounded exception from `docs/CONCURRENCY_AND_LOCKING.md`): None

## Payment Or Accounting Impact

- None. `ageGroupsApply` (pricing gate) untouched; N/A members remain fee-exempt via existing behaviour.

## Migration Or Deployment Impact

- None. No schema change.

## Docs Updated

- `docs/guides/membership-types.md`, `CONFIGURATION.md`.

## Residual Risks

- None carried forward. Both adversarial review lenses (membership-lifecycle incl. merge guard; validation/API contract) reported no blockers/majors; their two confirmed residuals (stale merge-guard comment, missing PATCH-to-N/A pin) were fixed in-PR (e5994c7c).

## Manual Checks Required

- Owner approval required before merge (membership lifecycle surface): merge only on the exact comment "Approved and ok to merge" on this PR.

## Safety Confirmation

- [x] I did not use production credentials, production databases, production backups, live Stripe, live Xero, live SES, live Sentry, or live provider webhooks for exploratory validation.
- [x] Merge handling follows the `AGENTS.md` "Completion and Merge" risk gate: eligible Low/Medium-risk PRs may merge (and close their linked issue) once CI is green; Critical or High-risk changes — security, payments, booking, membership, Xero/Stripe/SES/Sentry, schema/migrations, deployment, or data integrity — wait for explicit owner approval. Merge commits only.

🤖 Generated with [Claude Code](https://claude.com/claude-code)


