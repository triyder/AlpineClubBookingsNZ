# Issue #4055 — Local-Build Image Name Reproduction, 25 October 2026

**Audience:** Developer, Agent.

**Issue:** [#4055](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4055)
· **Base:** `main @ 948358190` · **Status:** point-in-time evidence; the issue
holds the live status.

**Verdict: the claimed `tacbookings`-fallback defect does not reproduce.** For
the five directory names listed under Results, with no `COMPOSE_PROJECT_NAME`
anywhere, Compose and the engine name the same `:local` images. The literal
`tacbookings` fallback in `docker-compose.yml` is never selected, because
Compose supplies its resolved project name for interpolation. This confirms the
13 October result on v5.6.1 and v2.24.7; v2.11.0 and v2.2.3 refuse to parse
the file, so no image-name comparison is possible on those releases.

Two *different* configurations do produce differing names (see
[Adjacent cases](#adjacent-cases-outside-the-claim)). Neither is the claim, and
neither involves the `tacbookings` fallback. Whether either deserves its own
issue is a decision for the owner.

No containers, image builds, Docker daemon, deploys, production data or live
providers were used. No application code changed.

## What was compared

- **Engine:** `get_service_image_ref` in
  `scripts/run-production-blue-green-deploy.sh`, extracted verbatim from the
  tracked script at the recorded base and evaluated with `docker` stubbed. The
  function derives the project name as `basename "$PROJECT_DIR"` lowercased. The
  engine `cd`s into `PROJECT_DIR` before running Compose.
- **Compose:** `docker compose --profile migrate config` rendered from the
  tracked `docker-compose.yml`, copied into a synthetic directory. There was no
  `.env` and no exported `COMPOSE_PROJECT_NAME`, and `DB_PASSWORD` (the file's
  only `:?` variable) was set to a placeholder. The `image:` of `app`,
  `app_blue`, `app_green` and `migrate` was read back from the render.
- **Compose binaries:** the official standalone releases v5.6.1,
  v2.24.7, v2.11.0 and v2.2.3, downloaded from `github.com/docker/compose`. The
  `config` command needs no daemon.

## Results

| Compose | Directory names | Result |
| --- | --- | --- |
| v5.6.1, v2.24.7 | `alp-21`, `AlpineClubBookingsNZ`, `tacbookings`, `club_lodge`, `9lodge` | **Match** for all four services. For example, `AlpineClubBookingsNZ` gives `alpineclubbookingsnz-app:local` and `alpineclubbookingsnz-migrate:local` on both sides. |
| v2.11.0, v2.2.3 | all | `config` **refuses the file**: these releases cannot parse the nested `${APP_IMAGE:-${COMPOSE_PROJECT_NAME:-tacbookings}-app:local}` default (`invalid interpolation format for x-app-service.image`). They fail loudly rather than choosing `tacbookings`. |

No tested release names a `tacbookings-…:local` image for a directory with any
other name.

## Adjacent cases outside the claim

These cases differ on both v5.6.1 and v2.24.7:

| Configuration | Compose image | Engine image |
| --- | --- | --- |
| Directory `My.Lodge` | `mylodge-app:local` | `my.lodge-app:local` |
| Directory `lodge two` | `lodgetwo-app:local` | `lodge two-app:local` |
| `.env` holds `COMPOSE_PROJECT_NAME=otherclub` (not exported) | `otherclub-app:local` | `<directory>-app:local` |

1. **Normalisation.** Compose drops characters outside `[a-z0-9_-]` from a
   directory-derived name. The engine only lowercases it.
2. **`.env`-only project name.** Compose reads `COMPOSE_PROJECT_NAME` from
   `.env`. The engine's shell does not.

Both cases **fail closed** when no stale image exists: `get_service_image_ref`
runs `docker image inspect` under `set -e`. With only Compose's image present,
evaluating the function for `My.Lodge` stopped with
`Unable to inspect image: my.lodge-app:local`, exit 1. They become the issue's
"validates one image, runs another" only if an earlier build left an image
under the engine's spelling. The wrapper deploy is unaffected, because it always
exports `COMPOSE_PROJECT_NAME`.

## Re-running the check

Save the harness below as `repro-4055.sh` outside the checkout. Use trusted
official Compose release binaries, verifying their published checksums before
execution, then run
`repro-4055.sh <checkout> /abs/path/docker-compose-v5.6.1 …`. It prints one line
per directory, Compose version and service, and exits non-zero on any mismatch
or render failure. The 25 October run exited 1: 40 matching lines, 24 mismatching
(all from the adjacent cases), and 16 render refusals from the two older releases.
The harness pins both inputs to the recorded base, disables Git's on-demand
object fetching, and runs Compose with an empty environment apart from `PATH`,
a synthetic `HOME`, and the placeholder password. The pinned objects must
already be available locally, and Git must support `--no-lazy-fetch`.
This prevents caller secrets and Compose settings from affecting the render; it
is not a sandbox for untrusted executables. Inspect the pinned function before
running the harness; `eval` executes that repository code.

```bash
#!/usr/bin/env bash
# Offline reproduction harness for issue #4055. No daemon, no builds, no containers.
# Usage: repro-4055.sh <repo-checkout> <compose-binary>...
set -euo pipefail
if [ "$#" -lt 2 ]; then
  printf 'Usage: %s <repo-checkout> <compose-binary>...\n' "$0" >&2
  exit 2
fi
REPO="$1"; shift
REV=9483581902dbb086ffc5b4d67f45ae8110f1761c
# Pull the engine's real function out of the tracked script, verbatim.
FUNC="$(git --no-lazy-fetch --no-replace-objects -C "$REPO" show "$REV:scripts/run-production-blue-green-deploy.sh" | sed -n '/^get_service_image_ref() {/,/^}/p')"
[ -n "$FUNC" ] || { echo "get_service_image_ref not found" >&2; exit 2; }
CRON_SERVICE=app BLUE_SERVICE=app_blue GREEN_SERVICE=app_green MIGRATE_SERVICE=migrate
docker() { return 0; }   # stub: only `docker image inspect` is called by the function
eval "$FUNC"
unset COMPOSE_PROJECT_NAME APP_IMAGE MIGRATE_IMAGE COMPOSE_FILE COMPOSE_PROFILES

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/repro-4055-XXXXXX")"
# Directory names; an optional "|NAME" suffix writes `.env` COMPOSE_PROJECT_NAME=NAME
# (outside the issue's stated configuration, which has no .env line).
DIRS=(alp-21 AlpineClubBookingsNZ tacbookings club_lodge 9lodge My.Lodge "lodge two" "alp-21|otherclub")
fail=0
for dc in "$@"; do
  ver="$(env -i PATH="$PATH" HOME="$ROOT" "$dc" version --short 2>/dev/null || env -i PATH="$PATH" HOME="$ROOT" "$dc" version)"
  for spec in "${DIRS[@]}"; do
    d="${spec%%|*}"; envname=""; [ "$spec" = "$d" ] || envname="${spec#*|}"
    dir="$ROOT/$(basename "$dc")/${envname:+envfile-}$d"; mkdir -p "$dir"; d="$(basename "$dir")"
    git --no-lazy-fetch --no-replace-objects -C "$REPO" show "$REV:docker-compose.yml" > "$dir/docker-compose.yml"
    [ -z "$envname" ] || printf 'COMPOSE_PROJECT_NAME=%s\n' "$envname" > "$dir/.env"
    # Compose's view: render the real file with no exported project name.
    # The file's only `:?` variable is DB_PASSWORD; a placeholder lets it render.
    rendered="$(cd "$dir" && env -i PATH="$PATH" HOME="$ROOT" DB_PASSWORD=placeholder "$dc" --profile migrate config 2>&1)" || {
      echo "[$ver] dir='$d' compose config FAILED: $(printf '%s' "$rendered" | tail -1)"; fail=1; continue; }
    for svc in "$CRON_SERVICE" "$BLUE_SERVICE" "$GREEN_SERVICE" "$MIGRATE_SERVICE"; do
      compose_img="$(printf '%s\n' "$rendered" | awk -v s="  $svc:" '
        $0==s {in_s=1; next}
        in_s && /^  [^ ]/ {in_s=0}
        in_s && /^    image:/ {sub(/^    image: */,""); gsub(/"/,""); print; exit}')"
      engine_img="$(PROJECT_DIR="$dir" get_service_image_ref "$svc")"
      if [ "$compose_img" = "$engine_img" ]; then verdict=MATCH; else verdict=MISMATCH; fail=1; fi
      printf '[%s] dir=%-22q svc=%-9s compose=%-34s engine=%-34s %s\n' \
        "$ver" "$d" "$svc" "$compose_img" "$engine_img" "$verdict"
    done
  done
done
exit "$fail"
```
