import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Settings for TokenEconomizer on DSH.
 *
 * Deliberately plain: no schema library, because the loader hands the plugin a
 * plain object and every key here has to stay meaningful. Upstream knobs that
 * only feed machinery this port does not implement (the micro-skill proposer,
 * the loop-guard judge model, the deny-list write-back) are absent rather than
 * accepted-and-ignored, so a setting is never a lie.
 */

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");

export const DEFAULT_STATE_DIR = join(DSH_HOME, "tokeneconomizer");

export const DEFAULTS = Object.freeze({
  /** Master switch. `TE_DISABLE=1` beats every other setting. */
  enabled: true,
  /** off: nothing is injected. on: deterministic repeated-failure facts. */
  microskills: "off",
  /** off: no filtering. propose: report only (logs). on: deny unused tools. */
  toolprune: "on",
  /** Unused-prompt count that, with min_sessions, justifies dropping a tool. */
  toolprune_evidence: 10,
  /** Sessions in which the tool went unused before the prompt rule may fire. */
  toolprune_min_sessions: 2,
  /** Sessions in which the tool went unused before it is dropped outright. */
  toolprune_sessions: 5,
  /** off: no intervention. on: redirect on repeating failures. */
  loopguard: "on",
  /** Well-ended turns needed before the call-count backstop is trusted. */
  loopguard_envelope_min_samples: 5,
  /** Redirects per turn; further repeats get one "still stuck" notice. */
  loopguard_nudges: 1,
  /** Turn call count must exceed median * this to arm the backstop. */
  loopguard_backstop_mult: 2.5,
  /** Where per-repo JSON state is kept. */
  stateDir: DEFAULT_STATE_DIR,
  /** Delegated subagent sessions never learn, prune, or nudge. */
  skipSubagentSessions: true,
});

const MODES = {
  microskills: ["off", "on"],
  toolprune: ["off", "propose", "on"],
  loopguard: ["off", "on"],
};

const NUMBERS = {
  toolprune_evidence: { min: 1, max: 10_000 },
  toolprune_min_sessions: { min: 1, max: 1_000 },
  toolprune_sessions: { min: 1, max: 1_000 },
  loopguard_envelope_min_samples: { min: 1, max: 1_000 },
  loopguard_nudges: { min: 0, max: 100 },
  loopguard_backstop_mult: { min: 1, max: 100 },
};

function modeValue(value) {
  if (value === true) return "on";
  if (value === false) return "off";
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "1" || lowered === "yes" || lowered === "true") return "on";
    if (lowered === "0" || lowered === "no" || lowered === "false") return "off";
    return lowered;
  }
  return undefined;
}

function pickMode(target, key, raw) {
  const value = modeValue(raw);
  if (value && MODES[key].includes(value)) target[key] = value;
  return target;
}

function pickNumber(target, key, raw) {
  const value = typeof raw === "number" ? raw : Number(raw);
  const bounds = NUMBERS[key];
  if (!Number.isFinite(value)) return target;
  if (value < bounds.min || value > bounds.max) return target;
  target[key] = value;
  return target;
}

function pickBoolean(target, key, raw) {
  if (typeof raw === "boolean") target[key] = raw;
  else if (raw === "1" || raw === "true") target[key] = true;
  else if (raw === "0" || raw === "false") target[key] = false;
  return target;
}

function pickString(target, key, raw) {
  if (typeof raw === "string" && raw.trim() !== "") target[key] = raw.trim();
  return target;
}

/**
 * Resolve settings from environment, then plugin input (input wins).
 * Unknown keys are dropped, out-of-range values keep the default, and a
 * malformed value never aborts boot.
 */
export function resolveConfig(input = {}, env = process.env) {
  const config = { ...DEFAULTS };

  if (env.TE_DISABLE === "1" || env.TE_DISABLE === "true") config.enabled = false;
  if (env.TE_MICROSKILLS !== undefined) pickMode(config, "microskills", env.TE_MICROSKILLS);
  if (env.TE_TOOLPRUNE !== undefined) pickMode(config, "toolprune", env.TE_TOOLPRUNE);
  if (env.TE_LOOPGUARD !== undefined) pickMode(config, "loopguard", env.TE_LOOPGUARD);
  if (env.TE_STATE_DIR !== undefined) pickString(config, "stateDir", env.TE_STATE_DIR);

  if (input && typeof input === "object") {
    if (input.enabled !== undefined) pickBoolean(config, "enabled", input.enabled);
    if (input.microskills !== undefined) pickMode(config, "microskills", input.microskills);
    if (input.toolprune !== undefined) pickMode(config, "toolprune", input.toolprune);
    if (input.loopguard !== undefined) pickMode(config, "loopguard", input.loopguard);
    if (input.stateDir !== undefined) pickString(config, "stateDir", input.stateDir);
    if (input.skipSubagentSessions !== undefined) {
      pickBoolean(config, "skipSubagentSessions", input.skipSubagentSessions);
    }
    for (const key of Object.keys(NUMBERS)) {
      if (input[key] !== undefined) pickNumber(config, key, input[key]);
    }
  }

  // `TE_DISABLE` is a kill switch, not a default: it must survive a config block
  // that says `enabled: true`, or a stuck user has no way out from the environment.
  if (env.TE_DISABLE === "1" || env.TE_DISABLE === "true") config.enabled = false;

  // A backstop multiplier below 1 would fire on every turn.
  if (config.loopguard_backstop_mult < 1) config.loopguard_backstop_mult = DEFAULTS.loopguard_backstop_mult;
  return Object.freeze(config);
}

/** Names of every setting the user can actually set, for `doctor` output. */
export function describableConfig(config) {
  return {
    enabled: config.enabled,
    microskills: config.microskills,
    toolprune: config.toolprune,
    toolprune_evidence: config.toolprune_evidence,
    toolprune_min_sessions: config.toolprune_min_sessions,
    toolprune_sessions: config.toolprune_sessions,
    loopguard: config.loopguard,
    loopguard_envelope_min_samples: config.loopguard_envelope_min_samples,
    loopguard_nudges: config.loopguard_nudges,
    loopguard_backstop_mult: config.loopguard_backstop_mult,
    stateDir: config.stateDir,
    skipSubagentSessions: config.skipSubagentSessions,
  };
}
