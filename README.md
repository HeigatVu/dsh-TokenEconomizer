# dsh-TokenEconomizer

Cost control for long agent sessions in the [DeepSeek Harness](https://github.com/deepseek-ai/dsh).
Three mechanisms watch a repository's own session history and then spend less: fewer
unused tool definitions in every prompt, fewer failures rediscovered session after
session, and a way out of a turn that is repeating itself.

A port of [Microsoft's TokenEconomizer](https://github.com/microsoft/TokenEconomizer)
onto DSH's native extension points. No subprocess on the tool path, no API key, and
no model calls of its own — everything it does is deterministic and local.

## At a glance

| Mechanism | What it changes | Default |
| --- | --- | --- |
| **Micro-skills** | Injects up to four facts learned from failures that recurred in two or more earlier sessions, once per session | `off` |
| **Tool pruning** | Hides tools this repository has never used, per agent, reversibly | `on` |
| **Loop guard** | One redirect when a turn keeps failing the same way; one notice if it continues | `on` |

All three are evidence-gated and per repository: nothing fires on a fresh repository,
nothing is global, and everything unwinds when the agent ends. Micro-skills are off by
default, matching upstream — turn them on once the repository has a few sessions behind it.

## Requirements

- DSH `>=0.2.1-rc.1 <0.3.0`
- Node `^22.19.0 || >=24`
- Any OS Node runs on — no native dependencies, no build step

## Install

This repository *is* a DSH bundle: `package.json` declares `dsh.bundle.patch`, and
`cordis.patch.yml` mounts one entry. Install it from wherever you cloned it.

### Ask your harness (recommended)

In a DSH session:

> install the DSH bundle at /absolute/path/to/dsh-TokenEconomizer

The harness runs `plugin_manager` → `install_bundle`, which writes exactly two things into
`$DSH_HOME/profiles/<profile>/package.json`:

- a `link:` dependency pointing at the directory, and
- the package name in `dsh.profile.bundles`.

### By hand

```bash
dsh plugin --profile web add /absolute/path/to/dsh-TokenEconomizer
```

`dsh plugin` forwards its arguments to pnpm, so this adds the dependency but **does not**
register the bundle. Then add `@ducvu/dsh-tokeneconomizer-plugin` to the
`dsh.profile.bundles` array in `$DSH_HOME/profiles/web/package.json` yourself.

### Restart, then verify

Bundle lists are read at boot, so restart the process that runs DSH:

```bash
systemctl --user restart deepseek-harness   # or however you start `dsh web`
```

In the next session ask the harness to list plugins — `dsh-tokeneconomizer` should be
there and enabled. If it is not, check that the package is in `dsh.profile.bundles`; that
array, not the dependency, is what mounts it.

## Uninstall

Remove the bundle (ask the harness to remove it, or delete both entries from
`package.json`), restart, and optionally delete its state:

```bash
rm -rf "${DSH_HOME:-$HOME/.dsh}/tokeneconomizer"
```

## What you will actually see

### Micro-skills (default off)

Once enabled, the first step of a session may carry one notice:

```
TokenEconomizer micro-skills for this repository (learned from earlier sessions; confirm before relying on them):
- bash failed in 2 earlier sessions: command not found: pytest
```

A fact only exists if the *same shape* of failure — tool plus error text, with ids,
numbers and paths collapsed — was seen in **two or more separate sessions**. A single bad
turn is never enough. At most four facts, ~600 characters, once per session.

### Tool pruning (silent by design)

There is no notice: the tool simply is not offered to the agent. If a tool you expected is
missing, see [Troubleshooting](#troubleshooting) — one setting or one file restores it.

### Loop guard

When the same failure signature repeats three times in one turn, or a turn runs past
`median(successful turn calls) × 2.5`, one redirect is injected:

```
TokenEconomizer loop guard: this turn is repeating a failure instead of making progress.
- Same failure 3 time(s): bash: exit code 1: cannot find module 'x'
- Tool calls this turn: 14 (this repo's median successful turn: 9)

Stop retrying. Read the actual error, check the assumption behind it, and change
approach — different arguments, a different tool, or ask the user what they meant
before spending another attempt.
```

If the turn keeps going the same way, one further notice suggests interrupting with `Esc`
— and then the guard stays quiet for the rest of the turn, by design. It never stops a
turn itself.

## How each mechanism decides

### Tool pruning

For every tool in the agent's catalog, the plugin counts the repository's sessions that
went by without using it. Two rules can hide a tool:

| Rule | Fires when | Threshold | Why |
| --- | --- | --- | --- |
| sessions | unused in this many sessions | `toolprune_sessions` = 5 | it is simply not this repository's workflow |
| prompts | unused across this many prompts, in at least `toolprune_min_sessions` sessions | `toolprune_evidence` = 10, `toolprune_min_sessions` = 2 | plenty of opportunity, no use |

Two guards keep this conservative:

- **A tool this repository has ever called is never hidden**, however long ago that was.
- No decision is made until at least `toolprune_min_sessions` sessions with real prompts
  are on record.

It is applied as `ToolRuntime.restrict({ deny })` on the agent's own scope: the tool stays
registered globally, only that agent stops inheriting it, and the restriction evaporates
when the agent is disposed. Nothing on disk is edited. `toolprune: "propose"` logs the same
decisions and hides nothing — use it to audit before trusting the `on` default.

### Loop guard

- **Failure counting** — failures are normalized to a signature (tool + error text, ANSI
  stripped, hex ids → `<id>`, numbers → `<n>`, path runs → `<path>`) and counted within
  the turn.
- **Envelope backstop** — a repository's typical turn is the median tool-call count of
  turns that *ended well* (last tool result was not an error). Once there are
  `loopguard_envelope_min_samples` = 5 of those, a turn exceeding the median ×
  `loopguard_backstop_mult` = 2.5 while still accumulating failures arms the guard. A
  fresh repository is never judged against a guess.
- **Budget** — `loopguard_nudges` = 1 redirect per turn, then exactly one "still stuck"
  notice, then silence.

`dsh-repeat-tool-reminder` (shipped with DSH) already catches *identical* tool calls. This
guard catches the different shape: different calls, failing the same way.

## Configuration

Settings go on the mounted entry's `config` block, or in the environment. Precedence is
**defaults → environment → bundle config** (the config block wins). An invalid value keeps
the default and is reported; nothing here can fail a boot.

| Key | Default | Set in env | Notes |
| --- | --- | --- | --- |
| `enabled` | `true` | `TE_DISABLE=1` | master switch |
| `microskills` | `"off"` | `TE_MICROSKILLS` | `off` \| `on` |
| `toolprune` | `"on"` | `TE_TOOLPRUNE` | `off` \| `propose` \| `on` |
| `toolprune_evidence` | `10` | — | unused prompts that, with the next two, justify hiding |
| `toolprune_min_sessions` | `2` | — | sessions that must also have gone unused |
| `toolprune_sessions` | `5` | — | unused sessions that justify hiding outright |
| `loopguard` | `"on"` | `TE_LOOPGUARD` | `off` \| `on` |
| `loopguard_envelope_min_samples` | `5` | — | well-ended turns required before the backstop arms |
| `loopguard_nudges` | `1` | — | redirects per turn |
| `loopguard_backstop_mult` | `2.5` | — | multiple of the median well-ended turn |
| `stateDir` | `$DSH_HOME/tokeneconomizer` | `TE_STATE_DIR` | where per-repository JSON lives |
| `skipSubagentSessions` | `true` | — | delegated agents neither learn, prune, nor get nudged |

Environment variables only carry the switches above; numbers must come from the config
block. `TE_DISABLE=1` beats everything, including `enabled: true` in the block.

## State

One JSON file per repository, named `<folder>-<10 hex of sha256(realpath)>`, written
atomically (temp file + rename) and debounced. Retained per repository: the last 20
sessions, 200 turns per session, 60 failure signatures — so a long-lived repository cannot
grow without bound. State is keyed per directory on purpose: two unrelated folders must
never inherit each other's pruned tools.

Delete the file (or the whole `stateDir`) to make the plugin forget a repository. It will
learn from scratch on the next session.

## Deliberate limits

Being explicit beats shipping knobs that do nothing.

- **No model calls.** Upstream can pay a model to propose micro-skills and a judge to keep
  them (`microskills_propose_every`, `loopguard.judge_confidence`). This port has no judge
  and no proposer, so those settings do not exist; the deterministic evidence path is the
  whole mechanism. Nothing here costs anything beyond the tokens it saves.
- **No settings write-back.** Upstream edits the agent's settings file to prune tools and
  restores from it later. DSH has no per-repository settings file, so the restriction lives
  on the agent scope instead: reversible, free, and impossible to leave behind after a crash.
- **No turn halting.** Like upstream, the plugin only informs. The agent or the person
  decides whether to continue.
- **No repository map** (`repomap` upstream) and no Claude/Codex/Pi/Copilot adapter layer —
  DSH's events replace that layer by construction. See [`UPSTREAM.md`](./UPSTREAM.md).

## Troubleshooting

**Nothing happens after install.** Bundles mount at boot: restart the DSH process, then
confirm `@ducvu/dsh-tokeneconomizer-plugin` is in `dsh.profile.bundles` in
`$DSH_HOME/profiles/<profile>/package.json`. Having it in `dependencies` is not enough.

**Micro-skills never appear.** They are off by default. Turn them on, then give the
repository time: the same failure must occur in two or more separate sessions before a fact
exists.

**A tool I need is missing.** Pruning hid it — which means this repository never called it
before. Restore everything with `toolprune: "off"`, or delete that repository's state file
to reset its history. Audit future decisions with `toolprune: "propose"`.

**Pruning never happens.** It needs at least `toolprune_min_sessions` (2) sessions with
prompts, and only tools never called in this repository are candidates. On a busy
repository that has touched everything, there is nothing to prune — that is the intended
conservative behaviour.

**Nothing happens at all.** Check `TE_DISABLE` in the environment of the process that runs
DSH, and whether the bundle entry was removed from the profile.

**Where is the state?** `echo "${DSH_HOME:-$HOME/.dsh}/tokeneconomizer"`, or whatever
`stateDir` says.

## Failure behaviour

Every hook is fail-open: a bug in this plugin falls back to the unmodified agent loop,
because a cost plugin that breaks a session costs more than it saves.

- A missing `@deepseek-ai/dsh-llm` peer degrades the notice to an equivalent hand-built user
  message instead of throwing.
- A missing tool runtime skips pruning and logs a warning.
- A corrupt or unreadable state file is a cold start, not a crash.
- Save failures are reported and retried on the next boundary.

## Development

```bash
npm run check            # syntax-check every module
npm test                 # thresholds, signatures, pruning rules, guard behaviour
npm run upstream:diff    # did the mechanisms we ported move upstream?
```

`npm test` runs the real handlers against a fake harness context over a real temporary state
directory — it asserts what an agent would actually receive: that pruning denies the right
tools at `agent/created`, that facts arrive once before the user message, and that the third
identical failure produces exactly one redirect. No fixtures to maintain, no network.

[`UPSTREAM.md`](./UPSTREAM.md) holds the port map, the sync loop (`npm run upstream:diff`,
`git sync` in the upstream clone) and the drift ledger. Read it before porting any upstream
change.

| File | Role |
| --- | --- |
| `index.mjs` | wiring: the four hook points, per-agent and per-repository bookkeeping |
| `config.mjs` | defaults, environment, clamping — a bad value never aborts boot |
| `store.mjs` | per-repository JSON: atomic writes, retention caps |
| `microskills.mjs` | failure signatures and the learned-fact notice |
| `toolprune.mjs` | usage accounting and the deny decision |
| `loopguard.mjs` | turn accounting, envelope, redirect text |
| `upstream.mjs` | the upstream sync report (developer tool, not shipped) |

## Relationship to upstream

This is a port, not a fork: it shares no git history with
`microsoft/TokenEconomizer` and its Python hook plugins. Upstream's mechanisms and evidence
thresholds were reproduced deliberately; the transport was replaced:

```
TokenEconomizer (upstream)            dsh-TokenEconomizer (this plugin)
──────────────────────────            ─────────────────────────────────
microskills  ── SessionStart   ──▶    agent/pre-step       (one notice, once per session)
toolprune    ── settings file  ──▶    ToolRuntime.restrict({ deny })  on the agent scope
loopguard    ── PostToolUse    ──▶    tools/post-execute   (additionalContexts)
```

Upstream ships one Python `te-hook` process per event, reading JSON on stdin. DSH has no
Claude-format hook bridge, and a subprocess on every tool call is latency on every step, so
this plugin speaks DSH's typed events directly and keeps every decision in-process.

## License and credit

MIT for this port. The mechanisms, thresholds and the paper are Microsoft's:
[TokenEconomizer](https://github.com/microsoft/TokenEconomizer) (Apache-2.0),
"Experience-Driven Black-Box Cost Control for Coding Agents", arXiv 2610.22732.
