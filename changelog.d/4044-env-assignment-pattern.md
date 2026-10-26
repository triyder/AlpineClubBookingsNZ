- **The deploy now catches a second `APP_ENVIRONMENT_ROLE` line written with
  a colon (#4026).** Docker Compose reads `KEY: value` in a `.env` file as well
  as `KEY=value`. The production deploy's check for a duplicated
  `APP_ENVIRONMENT_ROLE` only recognised the `=` form, so a second line such as
  `APP_ENVIRONMENT_ROLE: non-production` further down the file slipped past it,
  and Compose then handed that value to every container.

  The check now counts every shape Compose accepts — indented, `export `-prefixed,
  spaces around the separator, and `=` or `:` — and refuses the deploy at step 3
  when the key appears more than once. A single line in any of those shapes is
  still accepted. The rule lives in one function in
  `scripts/run-production-blue-green-deploy.sh`, `env_assignment_pattern`. A
  fork's own deploy checks can lift that definition out of the script, as this
  project's tests do (`src/lib/__tests__/helpers/deploy-script.ts`), instead of
  keeping a hand-made copy. Sourcing the script is not a way to reach it: that
  starts a production deploy.
