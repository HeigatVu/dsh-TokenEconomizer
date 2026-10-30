/**
 * Micro-skills: short, deterministic facts about this repository that survived
 * more than one session.
 *
 * Upstream proof-of-concept asks a model to propose candidate skills and a
 * judge to keep them. This port keeps the part that needs no extra model call:
 * a failure signature the agent hit in two or more separate sessions is a
 * durable property of the repository, not a one-off. Nothing here is inferred
 * from a single bad turn, because one failure is noise.
 */

/** Sessions a signature must appear in before it counts as a repo fact. */
export const CONFIRM_SESSIONS = 2;
/** Facts worth spending context on in one session. */
export const MAX_FACTS = 5;
const MAX_TEXT = 200;
const MAX_RENDERED = 900;

/**
 * Collapse a failure to its shape: identifiers, numbers and paths differ
 * between runs of the same underlying problem.
 */
export function failureSignature(toolName, text) {
  const raw = String(text ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s:'"`]+){2,}/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
  return `${toolName || "tool"}: ${raw || "failed"}`;
}

/**
 * The error text a tool result carries. DSH failures put the message in
 * `error.message`; anything else falls back to the rendered content.
 */
export function failureText(result) {
  const error = result?.error;
  if (error && typeof error === "object") {
    if (typeof error.message === "string" && error.message.trim() !== "") return error.message;
    if (typeof error.code === "string" && error.code.trim() !== "") return error.code;
  }
  if (typeof error === "string" && error.trim() !== "") return error;
  const block = Array.isArray(result?.content) ? result.content.find((item) => item?.type === "text") : undefined;
  if (block && typeof block.text === "string") return block.text;
  return "failed";
}

/**
 * Rebuild the fact list from raw session history. Deriving instead of storing
 * means a fact disappears by itself once old sessions age out — no separate
 * invalidation bookkeeping to get wrong.
 */
export function deriveFacts(state) {
  const seen = new Map();
  for (const session of state.sessions) {
    const failures = session?.failures ?? {};
    for (const [sig, value] of Object.entries(failures)) {
      if (!value || typeof value !== "object") continue;
      const entry = seen.get(sig) ?? { sig, sessions: 0, count: 0, text: "" };
      entry.sessions += 1;
      entry.count += Number(value.count) || 1;
      if (!entry.text && value.text) entry.text = String(value.text);
      seen.set(sig, entry);
    }
  }
  return [...seen.values()]
    .filter((fact) => fact.sessions >= CONFIRM_SESSIONS)
    .sort((a, b) => b.sessions - a.sessions || b.count - a.count)
    .slice(0, MAX_FACTS);
}

/** Render facts as one short user-facing notice, or "" when there is nothing to say. */
export function renderFacts(facts) {
  if (!Array.isArray(facts) || facts.length === 0) return "";
  const lines = facts.map((fact) => {
    const text = String(fact.text || "").replace(/\s+/g, " ").trim().slice(0, 160);
    const detail = text ? `: ${text}` : "";
    return `- ${fact.sig.split(": ")[0]} failed in ${fact.sessions} earlier sessions${detail}`;
  });
  const body = [
    "TokenEconomizer micro-skills for this repository (learned from earlier sessions; confirm before relying on them):",
    ...lines,
  ].join("\n");
  return body.length > MAX_RENDERED ? `${body.slice(0, MAX_RENDERED - 3)}...` : body;
}
