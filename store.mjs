import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Per-repository state for TokenEconomizer.
 *
 * One JSON file per repository keeps a project's evidence isolated, so a
 * monorepo of unrelated folders never inherits another folder's pruned tools.
 * Writes are atomic (tmp + rename) because a half-written evidence file would
 * silently reset what the agent has learned.
 */

const STATE_VERSION = 1;
const MAX_SESSIONS = 20;
const MAX_TURNS_PER_SESSION = 200;
const MAX_FAILURE_SIGNATURES = 60;

/** Resolve a project directory to a stable, readable, unique key. */
export function repoKey(directory) {
  let resolved = directory;
  try {
    resolved = realpathSync(directory);
  } catch {
    // A deleted or unreadable cwd still deserves a stable key.
  }
  const slug = (basename(resolved) || "repo").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "repo";
  const digest = createHash("sha256").update(resolved).digest("hex").slice(0, 10);
  return { key: `${slug}-${digest}`, directory: resolved };
}

export function statePath(config, directory) {
  const { key } = repoKey(directory);
  return join(config.stateDir, `${key}.json`);
}

export function emptyState(directory) {
  return { version: STATE_VERSION, repo: directory, sessions: [], facts: [], deny: null };
}

function coerceState(raw, directory) {
  const state = emptyState(directory);
  if (!raw || typeof raw !== "object" || raw.version !== STATE_VERSION) return state;
  if (Array.isArray(raw.sessions)) state.sessions = raw.sessions.filter(isSessionLike);
  if (Array.isArray(raw.facts)) state.facts = raw.facts.filter(isFactLike);
  if (raw.deny && Array.isArray(raw.deny.tools)) {
    state.deny = { tools: raw.deny.tools.filter((t) => typeof t === "string"), formedAt: raw.deny.formedAt ?? null };
  }
  return state;
}

function isSessionLike(session) {
  return Boolean(session) && typeof session === "object" && typeof session.id === "string";
}

function isFactLike(fact) {
  return Boolean(fact) && typeof fact === "object" && typeof fact.sig === "string";
}

export function loadState(config, directory) {
  const path = statePath(config, directory);
  try {
    return coerceState(JSON.parse(readFileSync(path, "utf8")), directory);
  } catch {
    // Missing or corrupt evidence is a cold start, never a crash.
    return emptyState(directory);
  }
}

export function saveState(config, directory, state) {
  const path = statePath(config, directory);
  try {
    mkdirSync(config.stateDir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(trimState(state), null, 2));
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** Bound what accumulates so a long-lived repo does not grow without limit. */
function trimState(state) {
  const sessions = state.sessions.slice(-MAX_SESSIONS).map((session) => ({
    ...session,
    turns: Array.isArray(session.turns) ? session.turns.slice(-MAX_TURNS_PER_SESSION) : [],
    failures: trimFailures(session.failures),
  }));
  return { ...state, sessions };
}

function trimFailures(failures) {
  if (!failures || typeof failures !== "object") return {};
  const entries = Object.entries(failures)
    .filter(([, value]) => value && typeof value === "object")
    .sort((a, b) => (b[1].count ?? 0) - (a[1].count ?? 0))
    .slice(0, MAX_FAILURE_SIGNATURES);
  return Object.fromEntries(entries);
}

/** A session record for the working turn stream. */
export function newSessionRecord(id, startedAt) {
  return { id, startedAt, prompts: 0, tools: {}, failures: {}, turns: [] };
}

/** Find or append the session record for an agent session id. */
export function sessionRecord(state, id) {
  let record = state.sessions.find((session) => session.id === id);
  if (!record) {
    record = newSessionRecord(id, Date.now());
    state.sessions.push(record);
  }
  return record;
}

export function recordToolUse(record, toolName) {
  if (typeof toolName !== "string" || toolName === "") return;
  record.tools[toolName] = (record.tools[toolName] ?? 0) + 1;
}

export function recordFailureSignature(record, sig, text) {
  const existing = record.failures[sig];
  if (existing) {
    existing.count += 1;
    if (text) existing.text = text;
    return existing.count;
  }
  record.failures[sig] = { count: 1, text: text ?? "" };
  return 1;
}

export function recordTurn(record, turn) {
  record.turns.push({
    calls: turn.calls,
    errors: turn.errors,
    wellEnded: turn.wellEnded ? 1 : 0,
  });
}
