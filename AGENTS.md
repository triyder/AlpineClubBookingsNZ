# Agent Guidelines

These instructions apply to automated coding agents working in this repository.

## Next.js Version Rule

This project uses a current Next.js release with APIs and conventions that may
not match older examples. Before changing framework behaviour, read the
relevant guide in `node_modules/next/dist/docs/` and follow deprecation notices.

## Local Safety

- Do not start local development servers in a shared, staging, or production
  checkout unless the repository owner explicitly asks for one.
- Do not use live Stripe, Xero, SES, Sentry, or production database credentials
  for tests or exploratory work.
- Do not run browser automation, DAST, load tests, or broad endpoint scanning
  against a live production deployment without a written test window.
- Prefer local PostgreSQL, staging Compose, Stripe test mode, and Xero demo
  tenants for validation.

## Validation Policy

This repository is often worked on from a lightweight Lightsail checkout.

- Do not run local production builds such as `npm run build`, `next build`,
  Docker image builds, or broad build-equivalent commands unless the repository
  owner explicitly asks for one in the current task.
- Use GitHub Actions as the source of truth for build, image, and full CI
  validation.
- After opening a PR, monitor GitHub checks with `gh pr checks <pr>` and inspect
  failed Actions logs with `gh run view --log`.
- Local validation should stay lightweight: targeted tests, `npm run lint`,
  `npx tsc --noEmit`, `npx prisma validate`, `npx prisma generate`, and
  `git diff --check` are acceptable when relevant.
- If a task appears to require a local build, stop and ask first.

## External Connectors

Before using any external connector, MCP tool, or third-party account, verify
that it belongs to the repository owner or was explicitly identified by the user
for the task. If the connector identity is unclear, do not call it.

## Change Discipline

- Keep money values in integer cents.
- Keep booking dates as New Zealand date-only values unless a feature explicitly
  requires time-of-day semantics.
- Keep external network calls outside long database transactions where possible.
- Do not add plaintext bearer-token storage.
- Update public docs when setup, architecture, deployment, or environment
  contracts change.
