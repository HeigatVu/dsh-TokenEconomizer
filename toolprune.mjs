/**
 * Tool pruning: drop a tool from the agent's visible surface only after this
 * repository has given evidence that the tool is dead weight.
 *
 * The tool stays registered globally and only the agent scope stops inheriting
 * it, which is exactly what `ToolRuntime.restrict` is for — so a prune is
 * reversible without touching any catalog.
 */

/**
 * Decide which catalog tools this repository has earned the right to hide.
 * Returns the deny list plus the evidence behind every entry, so `propose`
 * mode can report the same reasoning it would have acted on.
 */
export function planPrune(state, catalog, config) {
  const names = [...new Set((catalog ?? []).filter((name) => typeof name === "string" && name !== ""))];
  const sessions = (state?.sessions ?? []).filter(
    (session) => session && Number(session.prompts) > 0,
  );
  if (sessions.length < config.toolprune_min_sessions || names.length === 0) {
    return { deny: [], decisions: [], sessions: sessions.length };
  }

  const decisions = [];
  for (const name of names) {
    let unusedSessions = 0;
    let unusedPrompts = 0;
    for (const session of sessions) {
      if ((session.tools?.[name] ?? 0) > 0) continue;
      unusedSessions += 1;
      unusedPrompts += Number(session.prompts) || 0;
    }
    if (unusedSessions >= config.toolprune_sessions) {
      decisions.push({ tool: name, rule: "sessions", unusedSessions, unusedPrompts });
    } else if (unusedPrompts >= config.toolprune_evidence && unusedSessions >= config.toolprune_min_sessions) {
      decisions.push({ tool: name, rule: "prompts", unusedSessions, unusedPrompts });
    }
  }
  return { deny: decisions.map((decision) => decision.tool), decisions, sessions: sessions.length };
}

/**
 * Hide the denied tools for one agent scope. Returns a restore function, or
 * null when there is nothing to hide. Never throws: a pruning bug must not
 * break a session that would otherwise run.
 */
export function applyToolPrune(agent, deny) {
  if (!Array.isArray(deny) || deny.length === 0) return null;
  const tools = agent?.ctx?.tools;
  if (!tools || typeof tools.restrict !== "function") return null;
  try {
    const restore = tools.restrict({ deny: [...deny] });
    return typeof restore === "function" ? restore : null;
  } catch {
    return null;
  }
}

/** Read the agent-visible tool catalog as plain names. */
export function readCatalog(context) {
  const tools = context?.tools;
  if (!tools || typeof tools.schemas !== "function") return [];
  try {
    const schemas = tools.schemas();
    return Array.isArray(schemas) ? schemas.map((schema) => schema?.name).filter(Boolean) : [];
  } catch {
    return [];
  }
}
