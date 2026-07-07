#!/usr/bin/env bash
set -euo pipefail

INSTALL=0
TARGET="repo"

usage() {
  cat <<'USAGE'
Usage:
  scripts/codex/install-local-skills.sh [--dry-run] [--install] [--target repo|user]

Dry-run by default. With --install --target repo, copies docs/agents/codex/skills/* to
.agents/skills for repository discovery. With --target user, copies to
$HOME/.agents/skills.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install)
      INSTALL=1
      shift
      ;;
    --dry-run)
      INSTALL=0
      shift
      ;;
    --target)
      TARGET="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "install-local-skills: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "$TARGET" in
  repo)
    TARGET_DIR=".agents/skills"
    ;;
  user)
    TARGET_DIR="$HOME/.agents/skills"
    ;;
  *)
    echo "install-local-skills: --target must be repo or user" >&2
    exit 1
    ;;
esac

echo "Skill source: docs/agents/codex/skills"
echo "Skill target: $TARGET_DIR"

if [[ "$INSTALL" -ne 1 ]]; then
  echo "Dry run only. Re-run with --install to copy skill sources."
  for dir in docs/agents/codex/skills/*; do
    if [[ -d "$dir" && -f "$dir/SKILL.md" ]]; then
      echo "would copy $dir -> $TARGET_DIR/$(basename "$dir")"
    fi
  done
  exit 0
fi

mkdir -p "$TARGET_DIR"
for dir in docs/agents/codex/skills/*; do
  if [[ -d "$dir" && -f "$dir/SKILL.md" ]]; then
    rm -rf "$TARGET_DIR/$(basename "$dir")"
    cp -R "$dir" "$TARGET_DIR/$(basename "$dir")"
    echo "installed $TARGET_DIR/$(basename "$dir")"
  fi
done
