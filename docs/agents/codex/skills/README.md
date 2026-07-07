# Codex Skill Sources

These are repo-local source folders for optional Codex skills. They are kept in
`docs/agents/codex/skills` for review and version control.

Current Codex documentation supports repository-discoverable skills under
`.agents/skills`. This repo keeps source here and provides a dry-run installer:

```bash
scripts/codex/install-local-skills.sh
scripts/codex/install-local-skills.sh --install --target repo
```

The installer copies these folders to `.agents/skills` only when `--install` is
provided. Review the copied skills before relying on them. Do not install or
copy skills into user-local directories unless you explicitly choose that
target.
