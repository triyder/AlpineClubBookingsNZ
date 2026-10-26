# Models and Effort

**Audience: agent.** Last reviewed **5 Oct 2026**. Re-check this page when a
new model ships; if it is more than three months old, treat the names below as
possibly stale and say so in your brief.

[`AGENTS.md`](../../AGENTS.md) → "Model selection" is the policy: the
orchestrator chooses model and effort per task, preferring the least costly
combination expected to meet the quality bar, and `xhigh` is the ceiling. This
page names the current models so that policy can be applied. It is a default,
not a routing table — depart from it with a one-line reason in the brief.

## Why the defaults are the cheaper flagship

Opus 5.5 and GPT-6.1 Sol are at or near the top tier on agentic coding at a
fraction of the usage of Fable 5.1 and Astra, which consume the shared
allowance several times faster. Where the expensive model's lead is small or
unmeasured, the usage saving wins.

| Comparison | Where the default is as good or better | Where it falls short |
| --- | --- | --- |
| Opus 5.5 vs Fable 5.1 | Agentic coding (Anthropic: SWE-bench Pro 92.8% at `medium` vs 92.3%, about 1/5 the cost per solved task); terminal and repository tasks; faster | The hardest novel reasoning and long-horizon research, where Anthropic recommends Fable when Opus at higher effort still falls short; third-party reports of a lead on security-sensitive code generation (unverified) |
| Sol 6.1 vs Astra | Repository coding (DeepSWE v1.1 roughly level) at about 1/5 the cost; professional document work close | Computer use (Astra slightly ahead); difficult scientific work; no published head-to-head for code or security review |

Token prices are 2.5× (Fable over Opus) and 5× (Astra over Sol); subscription
usage is not a direct conversion, and retries, context and effort all count.

## Defaults

| Work | Claude Code | Codex | Effort |
| --- | --- | --- | --- |
| Orchestrator | Opus 5.5 | Sol 6.1 | `medium`; `high` for a gated wave; `xhigh` for long unattended Critical runs |
| Implementor — gated area (money, capacity, lifecycle, schema, auth, providers) | Opus 5.5 | Sol 6.1 | `high` |
| Implementor — well-specified Low/Medium work, docs, UI copy | Sonnet 5.5 | Sol 6.1 | `medium` |
| Review lens — correctness, invariants, concurrency, security, money | Opus 5.5 | Sol 6.1 | `high`; `xhigh` for a Critical security or money lens |
| Review lens — UX, docs, drift | Sonnet 5.5 | Sol 6.1 | `medium` |
| Search, extraction, mechanical checks with checkable output | Haiku 4.5 or Sonnet 5.5 | Luna | `low` (Haiku has no effort setting) |
| Planning and blueprints for High/Critical work | Opus 5.5 | Sol 6.1 | `high`–`xhigh` |

Exact identifiers: Claude aliases `opus` (Opus 5.5), `sonnet` (Sonnet 5.5),
`haiku` (Haiku 4.5), `fable` (Fable 5.1); Codex slugs `gpt-6.1-sol`,
`gpt-6-luna`, `gpt-6-astra`. Older slugs such as `gpt-6-sol`, `gpt-5.6-sol`
and `gpt-5.6-luna` are superseded — don't pick them by accident.

Terra (`gpt-5.6-terra`) is a previous generation; prefer Luna for cheap
bounded work. Haiku 4.5 has no effort setting and falls well behind on long
coding loops, so keep it to bounded, verifiable tasks.

## Escalating to Fable 5.1 or Astra

Escalate only when one of these is true, and say which in the brief:

- the default at `xhigh` has produced a wrong answer on this task twice, after
  context and instructions were checked;
- the task is in a category in the "falls short" column above and the result
  cannot be cheaply verified.

Never escalate silently, never as a fallback when a model is unavailable, and
never above `xhigh`.

## Setting model and effort

What a subagent actually runs on, first match wins:

- **Claude Code.**
  1. a `model` or `effort` passed on the `Agent` call;
  2. the role definition in [`.claude/agents/`](../../.claude/agents/):
     `implementor` and `reviewer` set both model and effort, `explorer` sets
     only its model;
  3. otherwise the main session's model, and for effort the user's
     per-model default (`modelSettings` in `settings.json`) or the session's.

  A launch with no role (`general-purpose`, a fork) takes step 3 for both.
- **Codex.**
  1. launch flags, `-m <model>` and `-c model_reasoning_effort=<level>`;
  2. the role file in [`.codex/agents/`](../../.codex/agents/), which sets both
     model and effort for all three roles;
  3. the `[agents]` subagent default in
     [`.codex/config.toml`](../../.codex/config.toml), read only in a trusted
     project;
  4. otherwise the session's own.

  The profiles in [`codex/profiles`](codex/profiles/README.md) set only
  sandbox, network and approval.

A role default is a starting point, not a requirement. Choose per task as
`AGENTS.md` → "Model selection" says, state the choice on the launch, and
never exceed `xhigh` whichever source sets it. Check the effective model
where the runtime shows it, and report any substitution.

## Sources

- Anthropic, [Prompting Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)
  and [Optimizing for cost and intelligence](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence).
- OpenAI, [GPT-6.1 Sol](https://openai.com/index/introducing-gpt-6-1-sol/) and
  the [model catalogue](https://developers.openai.com/api/docs/models).
- Vendor benchmarks, not measurements of this repository.
