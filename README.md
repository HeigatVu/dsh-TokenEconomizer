# dsh-TokenEconomizer

[TokenEconomizer](https://github.com/microsoft/TokenEconomizer) for the
[DeepSeek Harness](https://github.com/deepseek-ai/dsh) — experience-driven cost
control for coding agents, ported to DSH's own extension points instead of a
hook bridge.

Upstream ships plugins for Claude Code, Codex, Copilot CLI and opencode that
all funnel through one Python `te-hook` process reading JSON on stdin. DSH has
no Claude-format hook bridge installed, and a subprocess per tool call is real
latency on every single step. This port keeps upstream's *mechanisms* and their
evidence thresholds, and drops the process boundary: tool pruning uses the
harness's native per-scope tool filter, loop-guard redirects use the same
`additionalContexts` channel as the shipped `dsh-repeat-tool-reminder`, and
micro-skills are injected as a user notice at the step boundary.

```
TokenEconomizer (upstream)          dsh-TokenEconomizer (this plugin)
──────────────────────────          ─────────────────────────────────
microskills  ── SessionStart  ──▶   agent/pre-step  (notice, once per session)
toolprune    ── settings file ──▶   ToolRuntime.restrict({ deny })  per agent scope
loopguard    ── PostToolUse   ──▶   tools/post-execute (additionalContexts)
```

## What it does

Three mechanisms, each gated on evidence rather than vibes.

### 1. Micro-skills — repository facts that survived more than one session

A failure signature that shows up in two or more separate sessions is a
property of the repository, not a bad turn. On the first step of a session the
plugin injects one short notice listing up to five of them:

```
TokenEconomizer micro-skills for this repository (learned from earlier sessions; confirm before relying on them):
- bash failed in 2 earlier sessions: command not found: pytest
```

Facts are *derived* from session history on every read, so they age out on
their own — there is no separate invalidation bookkeeping to get wrong. One bad
turn is never enough. Default: **off**, matching upstream.

### 2. Tool pruning — hide what this repo never uses

For each tool in the agent's catalog the plugin counts the sessions that went
by without using it. A tool is hidden when either rule fires:

| Rule | Threshold | Meaning |
| --- | --- | --- |
| sessions | unused in `toolprune_sessions` (5) sessions | it is simply not this repo's workflow |
| prompts | unused across `toolprune_evidence` (10) prompts **and** `toolprune_min_sessions` (2) sessions | plenty of opportunity, no use |

Pruning is `ToolRuntime.restrict({ deny })` on the agent scope: the tool stays
registered globally and only this agent stops inheriting it, so it unwinds on
disposal and never edits a catalog. `toolprune: "propose"` reports the same
decisions in the log without acting. Restore anything by setting
`toolprune: "off"`. Default: **on**.

### 3. Loop guard — one redirect when a turn keeps paying for the same failure

`dsh-repeat-tool-reminder` already catches *identical* tool calls. This guard
catches the expensive shape: different calls failing the same way, and turns
that run far past what this repository's successful turns cost.

- the same normalized failure signature repeats **3×** in one turn, or
- tool calls exceed `median(successful turn calls) × loopguard_backstop_mult`
  (2.5) while accumulating failures

then one redirect is injected naming the failure and the call count. A repeat
after the redirect gets exactly one "still stuck — interrupt with `Esc`"
notice, and then the guard stays quiet. The envelope needs
`loopguard_envelope_min_samples` (5) successful turns before it is trusted, so a
fresh repository is never judged against a guess. Default: **on**.

## Install

From a shell:

```bash
dsh plugin --profile web add /path/to/dsh-TokenEconomizer
```

or from inside a DSH session, `plugin_manager` with action `install_bundle` and
the package directory as target. Either way the change lands on the next DSH
restart, because a new bundle rewrites the profile's bundle list.

The bundle patch mounts one entry:

```yaml
- insert:
    - id: dsh-tokeneconomizer
      name: '@ducvu/dsh-tokeneconomizer-plugin'
```

## Configuration

Set keys on the mounted entry's `config` block, or through environment
variables. Invalid values keep the default; nothing here can fail a boot.

| Key | Default | Env | Notes |
| --- | --- | --- | --- |
| `enabled` | `true` | `TE_DISABLE=1` | master switch |
| `microskills` | `"off"` | `TE_MICROSKILLS` | `off` \| `on` |
| `toolprune` | `"on"` | `TE_TOOLPRUNE` | `off` \| `propose` \| `on` |
| `toolprune_evidence` | `10` | | unused prompt count |
| `toolprune_min_sessions` | `2` | | sessions that must also be unused |
| `toolprune_sessions` | `5` | | unused sessions that justify hiding outright |
| `loopguard` | `"on"` | `TE_LOOPGUARD` | `off` \| `on` |
| `loopguard_envelope_min_samples` | `5` | | successful turns before the backstop arms |
| `loopguard_nudges` | `1` | | redirects per turn |
| `loopguard_backstop_mult` | `2.5` | | multiple of the median successful turn |
| `stateDir` | `$DSH_HOME/tokeneconomizer` | `TE_STATE_DIR` | per-repo JSON lives here |
| `skipSubagentSessions` | `true` | | delegated agents never learn or get pruned |

## State

One JSON file per repository, keyed `<folder>-<hash of realpath>`, written
atomically (tmp + rename) and debounced. Sessions are capped at the most recent
20, turns per session at 200, so a long-lived repository cannot grow without
bound. Delete a file to forget that repository.

State is per repository on purpose: a monorepo of unrelated folders must never
inherit another folder's pruned tools.

## Not ported

Being explicit beats leaving knobs that do nothing:

- **The model-side proposer and judge.** Upstream can ask a model to propose
  micro-skills and a judge to keep them (`microskills.propose_every`,
  `loopguard.judge_confidence`). This port has no extra model call, so those
  settings do not exist — the deterministic evidence path is the whole guard.
- **Deny-list write-back into a settings file.** DSH has no per-repo settings
  file to edit; the restriction lives on the agent scope instead, which is
  both reversible and free.
- **Turn halting.** Like upstream, the plugin never stops a turn. It informs;
  the user or the agent decides.

## Failing safely

Every hook is fail-open: a bug here falls back to the unmodified agent loop,
because a cost plugin that breaks a session costs more than it saves. A missing
`@deepseek-ai/dsh-llm` peer degrades the notice to an equivalent hand-built
user message. A missing `ToolRuntime` skips pruning with a warning. A corrupt
state file is a cold start.

## Development

```bash
npm run check   # syntax-check every module
npm test        # thresholds, signatures, pruning rules, guard behaviour
```

[`UPSTREAM.md`](./UPSTREAM.md) holds the port map, the upstream sync loop, and the
drift ledger — start there before porting any upstream change.

## License and credit

MIT for this port. The mechanisms, thresholds and paper are Microsoft's:
[TokenEconomizer](https://github.com/microsoft/TokenEconomizer), Apache-2.0,
"Experience-Driven Black-Box Cost Control for Coding Agents" (arXiv 2610.22732).
