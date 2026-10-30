/**
 * Loop guard: notice when a turn keeps paying for the same failure.
 *
 * The shipped repeat-tool-reminder already catches identical tool calls. This
 * guard catches the more expensive shape: different calls that keep failing the
 * same way, plus a cost backstop for turns that run far longer than this
 * repository's own successful turns do.
 */

/** Distinct calls share one signature this many times before it is a loop. */
export const REPEAT_THRESHOLD = 3;
/** Failures required before the call-count backstop may fire at all. */
const BACKSTOP_MIN_ERRORS = 3;

export function newTurn() {
  return { calls: 0, errors: 0, bySig: new Map(), nudges: 0, lastError: false, stopNotice: false };
}

/** Record one tool result; returns how many times its failure signature repeated. */
export function observeToolResult(turn, { isError, sig }) {
  turn.calls += 1;
  turn.lastError = Boolean(isError);
  if (!isError || !sig) return 0;
  turn.errors += 1;
  const seen = (turn.bySig.get(sig) ?? 0) + 1;
  turn.bySig.set(sig, seen);
  return seen;
}

function worstSignature(turn) {
  let worst = null;
  for (const [sig, count] of turn.bySig) {
    if (!worst || count > worst.count) worst = { sig, count };
  }
  return worst;
}

/**
 * Median tool-call count of this repository's well-ended turns, or null when
 * there are too few samples to trust. A median keeps one pathological turn
 * from widening everyone else's envelope.
 */
export function callEnvelope(state, config) {
  const calls = [];
  for (const session of state?.sessions ?? []) {
    for (const turn of session?.turns ?? []) {
      if (turn?.wellEnded) calls.push(Number(turn.calls) || 0);
    }
  }
  if (calls.length < config.loopguard_envelope_min_samples) return null;
  calls.sort((a, b) => a - b);
  const middle = calls.length >> 1;
  return calls.length % 2 === 1 ? calls[middle] : (calls[middle - 1] + calls[middle]) / 2;
}

/**
 * Decide whether to intervene. Returns `{kind:'nudge'}` for one redirect, then
 * `{kind:'stop'}` once, then null — the guard never nags.
 */
export function decideIntervention(turn, config, envelope) {
  if (config.loopguard !== "on" || config.loopguard_nudges === 0) return null;
  if (turn.errors === 0) return null;
  // Only the call that just failed can be evidence of a loop; a passing call
  // means the agent already changed something, so stay quiet.
  if (!turn.lastError) return null;

  const worst = worstSignature(turn);
  const repeated = Boolean(worst) && worst.count >= REPEAT_THRESHOLD;
  const backstop =
    envelope !== null &&
    envelope !== undefined &&
    turn.calls > envelope * config.loopguard_backstop_mult &&
    turn.errors >= BACKSTOP_MIN_ERRORS;
  if (!repeated && !backstop) return null;

  const signal = {
    sig: worst?.sig ?? "",
    count: worst?.count ?? 0,
    calls: turn.calls,
    errors: turn.errors,
    envelope,
  };
  if (turn.nudges < config.loopguard_nudges) {
    turn.nudges += 1;
    return { kind: "nudge", ...signal };
  }
  if (!turn.stopNotice) {
    turn.stopNotice = true;
    return { kind: "stop", ...signal };
  }
  return null;
}

function shortSig(sig) {
  const text = String(sig || "").replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** The redirect notice. Names the repeated failure so the agent can act on it. */
export function nudgeText(signal) {
  const lines = [
    "TokenEconomizer loop guard: this turn is repeating a failure instead of making progress.",
    `- Same failure ${signal.count} time(s): ${shortSig(signal.sig)}`,
    `- Tool calls this turn: ${signal.calls}${signal.envelope ? ` (this repo's median successful turn: ${signal.envelope})` : ""}`,
    "",
    "Stop retrying. Read the actual error, check the assumption behind it, and change approach — different arguments, a different tool, or ask the user what they meant before spending another attempt.",
  ];
  return lines.join("\n");
}

/** The one-shot notice for a turn that is still stuck after a redirect. */
export function stopText(signal) {
  return [
    "TokenEconomizer loop guard: still stuck after a redirect, so this turn is being left alone.",
    `- Failure seen ${signal.count} time(s): ${shortSig(signal.sig)}`,
    `- Tool calls this turn: ${signal.calls}`,
    "",
    "Interrupt with Esc and restate the goal; continuing on the same path only spends tokens.",
  ].join("\n");
}
