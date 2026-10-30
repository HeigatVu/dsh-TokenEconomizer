# Keeping this port in sync with TokenEconomizer

**Baseline: `microsoft/TokenEconomizer@1deb887` — "Merge pull request #80 from
microsoft/submission-limit", 2026-10-29.**

This repository is a **port, not a fork**. It reimplements the three mechanisms on
DSH's typed extension points, so an upstream commit never applies mechanically —
`git merge` is not the update path. This file is the mapping and the loop.

## Port map

| Upstream, under `tokeneconomizer/` | Here | What to compare |
| --- | --- | --- |
| `plugin/config.py` → `LiveConfig` | `config.mjs` | every default and every mode string |
| `microskills/envfacts.py` | `microskills.mjs` | the LLM-free fact families and their caps |
| `microskills/observe.py` | `store.mjs` + `microskills.mjs` | what counts as recurring evidence |
| `toolprune/stage.py`, `toolprune/tools.py` | `toolprune.mjs` | the never-used rule and its thresholds |
| `loopguard/rules.py` (`is_stuck`, `assess_abort`, `nudge_text`) | `loopguard.mjs` | the deterministic branch |
| `loopguard/envelope.py`, `loopguard/state.py`, `loopguard/turn.py` | `loopguard.mjs` (`callEnvelope`) + `store.mjs` | envelope sampling |
| `plugin/hosts.py`, `hook.py`, `cli.py`, adapters | replaced by DSH events — `index.mjs` | not ported, see below |
| `microskills/distiller.py`, `loopguard/judge.py` | — | paid LLM path, not ported |
| `toolprune/codex.py`, `loopguard/shell_edits.py` | — | Codex/Claude-specific, not ported |
| `repomap*.py` | — | no DSH equivalent yet |

## The update loop

```bash
UP=/home/ducvu/.dsh/.tmp/TokenEconomizer

# 1. Refresh the scratch clone (re-clone if it is gone)
git -C "$UP" pull --ff-only
#    git clone https://github.com/microsoft/TokenEconomizer.git "$UP"

# 2. Did any mechanism actually move? This is the only question that matters.
git -C "$UP" diff --stat 1deb887..origin/main -- \
  tokeneconomizer/plugin/config.py tokeneconomizer/microskills \
  tokeneconomizer/toolprune tokeneconomizer/loopguard

# 3. Read the hunks that matter
git -C "$UP" diff 1deb887..origin/main -- tokeneconomizer/plugin/config.py
git -C "$UP" diff 1deb887..origin/main -- tokeneconomizer/toolprune
git -C "$UP" diff 1deb887..origin/main -- tokeneconomizer/loopguard/rules.py
git -C "$UP" diff 1deb887..origin/main -- tokeneconomizer/microskills/envfacts.py
```

Then port **in this order**, because each one outranks the next when they disagree:

1. **Defaults** (`config.mjs`) — a changed default is the highest-value update: it is
   the exact setting the paper's measurements were taken at.
2. **Rules** (`toolprune.mjs`, `microskills.mjs`, `loopguard.mjs`) — which evidence
   counts, and what it triggers.
3. **Wording** (`nudgeText`, `stopText`, the injected fact line) — users read these.

Then:

```bash
npm run check && npm test
# bump the baseline sha at the top of this file
git commit -am "sync upstream <new-sha>" && git push
```

Finally re-run step 2 against the new sha and confirm the output is empty.

**Do not port anything under `tokeneconomizer/plugin/` except `config.py`.** That
directory is the host-adapter layer this port replaces by construction. `trace/` and
`experiments/` only matter when a threshold moved into them.

## Drift ledger (against baseline `1deb887`)

| Upstream setting / rule | Upstream | Here | State |
| --- | --- | --- | --- |
| `microskills` | `"off"` | `"off"` | same |
| `microskills_max_facts` | 4 | 4 | aligned |
| `microskills_max_tokens` | 150 | 150 (≈600 chars) | aligned |
| `microskills_propose_every` | 3 | — | no paid proposer |
| `toolprune` | `"auto"` | `"on"` | different word, same effect |
| `toolprune_evidence` / `_min_sessions` / `_sessions` | 10 / 2 / 5 | 10 / 2 / 5 | same |
| pruning rule | never-used tools only | never-used tools only | aligned |
| `toolprune_quiet_minutes` | 60 | — | no settings write-back to wait for |
| `toolprune_protect` (`config.py:154`) | `[]` | — | **not ported** |
| `loopguard` | `"nudge"` (judge decides) | `"on"` (deterministic) | judge not ported |
| `loopguard_aggr` | `"default"` | — | thresholds pinned at the `default` preset |
| `loopguard_nudges` | 1 | 1 | same |
| `shadow` (`config.py:164`) | `false` | — | **not ported** |
| `repomap*` | `"off"` | — | not ported |

On `toolprune: "auto"` vs `"on"`: upstream's `auto` waits `toolprune_quiet_minutes`
of repository idle before writing a deny list, so a resumed conversation does not lose
a warm prompt cache. There is no settings file here — the restriction is applied at
agent start and unwinds with the agent — so there is nothing to wait for, and the
observable effect (a prune lands on the next session, not mid-conversation) matches.

## Two settings worth porting next

Both are small, both exist upstream for a reason, neither is ported yet:

- **`toolprune_protect`** (`plugin/config.py:154`) — names or patterns that are never
  pruned. Today a dead-looking MCP tool can be hidden; this is the escape hatch.
  Fits `planPrune` as one more skip condition.
- **`shadow`** (`plugin/config.py:164`) — compute every decision, log it, act on none.
  The documented way to measure a mechanism before trusting it. Fits `index.mjs` as
  one flag checked at each of the three injection points.

## What not to copy

Do not resurrect `plugin/hosts.py`, `plugin/hook.py`, `plugin/cli.py` or the per-host
`hooks/*.json`. That layer exists because Claude Code, Codex, Copilot CLI and Pi
expose only a subprocess hook contract. DSH exposes typed events and a scoped tool
runtime, which is why this port has no subprocess in its hot path at all — and why
copying the adapter layer would be a regression, not a sync.
