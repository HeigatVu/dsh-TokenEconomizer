import { randomUUID } from "node:crypto";

import { resolveConfig, describableConfig } from "./config.mjs";
import {
  loadState,
  saveState,
  sessionRecord,
  recordToolUse,
  recordFailureSignature,
  recordTurn,
} from "./store.mjs";
import { deriveFacts, renderFacts, failureSignature, failureText } from "./microskills.mjs";
import { planPrune, applyToolPrune, readCatalog } from "./toolprune.mjs";
import { newTurn, observeToolResult, callEnvelope, decideIntervention, nudgeText, stopText } from "./loopguard.mjs";

export const name = "dsh-tokeneconomizer";
export const inject = ["agents", "sessions"];

const SOURCE = Object.freeze({ kind: "tokeneconomizer", form: "notice" });
const SAVE_DEBOUNCE_MS = 1500;

/**
 * TokenEconomizer for DeepSeek Harness.
 *
 * Three mechanisms, all native to the harness and all cheap enough to run on
 * every event:
 *   1. micro-skills — repository facts confirmed across sessions, injected once
 *   2. tool pruning  — evidence-gated per-scope tool denial, reversible
 *   3. loop guard    — a redirect when a turn keeps paying for one failure
 *
 * Every hook is fail-open: a bug here degrades to the unmodified agent loop,
 * because a cost plugin that breaks a session costs more than it saves.
 */

/** Factories that mint a real user message, when the peer package resolves. */
let createUserMessage = null;

async function loadMessageFactory() {
  try {
    const peer = await import("@deepseek-ai/dsh-llm");
    if (typeof peer?.createUserMessage === "function") createUserMessage = peer.createUserMessage;
  } catch {
    // Absent peer is not an error: the fallback shape is what createUserMessage
    // produces anyway (a frozen user message carrying our own source kind).
  }
}

function makeNotice(text, summary) {
  const content = [{ type: "text", text }];
  const source = { ...SOURCE, summary };
  try {
    if (createUserMessage) return createUserMessage({ content, source });
    return { id: randomUUID(), role: "user", content, source };
  } catch {
    return null;
  }
}

function log(ctx, level, message, error) {
  const logger = ctx?.logger;
  const write = typeof logger?.[level] === "function" ? logger[level] : null;
  if (!write) return;
  try {
    write.call(logger, `[tokeneconomizer] ${message}`, error);
  } catch {
    // Logging must never be the thing that breaks a turn.
  }
}

function isUserMessage(message) {
  return message?.source?.kind === "user";
}

export function apply(ctx, input = {}) {
  const config = resolveConfig(input);
  if (!config.enabled) {
    log(ctx, "info", "disabled by configuration");
    return;
  }
  void loadMessageFactory();

  /** agent -> per-agent bookkeeping */
  const agents = new WeakMap();
  /** repo directory -> { state, dirty, timer } */
  const repos = new Map();

  function repoEntry(directory) {
    let entry = repos.get(directory);
    if (!entry) {
      entry = { state: loadState(config, directory), dirty: false, timer: null };
      repos.set(directory, entry);
    }
    return entry;
  }

  function flush(entry) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (!entry.dirty) return;
    entry.dirty = false;
    if (!saveState(config, entry.state.repo, entry.state)) {
      log(ctx, "warn", `could not write state for ${entry.state.repo}`);
    }
  }

  function scheduleSave(entry) {
    entry.dirty = true;
    if (entry.timer) return;
    entry.timer = setTimeout(() => flush(entry), SAVE_DEBOUNCE_MS);
    entry.timer.unref?.();
  }

  function ensureAgent(agent) {
    const known = agents.get(agent);
    if (known) return known;

    const record = { repo: null, disabled: false, reason: "", turn: newTurn(), factsInjected: false, sessionId: null };
    agents.set(agent, record);

    const header = agent?.session?.header;
    record.sessionId = agent?.session?.id ?? null;

    if (config.skipSubagentSessions && header?.origin === "subagent") {
      record.disabled = true;
      record.reason = "subagent session";
    } else if (typeof header?.cwd !== "string" || header.cwd === "") {
      record.disabled = true;
      record.reason = "session has no working directory";
    } else {
      record.repo = header.cwd;
    }

    if (!record.disabled) pruneFor(record, agent);
    else log(ctx, "info", `not tracking this agent: ${record.reason}`);
    return record;
  }

  function pruneFor(record, agent) {
    if (config.toolprune === "off") return;
    const entry = repoEntry(record.repo);
    const plan = planPrune(entry.state, readCatalog(agent?.ctx), config);
    if (plan.decisions.length === 0) return;

    const names = plan.deny.join(", ");
    if (config.toolprune === "propose") {
      log(ctx, "info", `would hide ${plan.decisions.length} unused tool(s) in ${record.repo}: ${names}`);
      return;
    }

    const restore = applyToolPrune(agent, plan.deny);
    if (!restore) {
      log(ctx, "warn", `tool pruning unavailable for this agent scope; skipping (${names})`);
      return;
    }
    entry.state.deny = { tools: [...plan.deny], formedAt: Date.now() };
    scheduleSave(entry);
    ctx.effect?.(() => restore);
    log(ctx, "info", `hid ${plan.decisions.length} unused tool(s) in ${record.repo}: ${names}`);
  }

  function sessionFor(record, entry) {
    return sessionRecord(entry.state, record.sessionId ?? "unknown-session");
  }

  function finalizeTurn(record, entry, turn) {
    if (!turn || turn.calls === 0) return;
    recordTurn(sessionFor(record, entry), {
      calls: turn.calls,
      errors: turn.errors,
      wellEnded: !turn.lastError,
    });
    entry.dirty = true;
  }

  ctx.on("agent/created", ({ agent }) => {
    try {
      ensureAgent(agent);
    } catch (error) {
      log(ctx, "warn", "agent/created failed; continuing unmodified", error);
    }
  });

  ctx.on("agent/pre-step", async (payload, next) => {
    const { agent, messages } = payload ?? {};
    let record = null;
    try {
      record = ensureAgent(agent);
      if (!record.disabled) {
        const entry = repoEntry(record.repo);
        const userMessages = (messages ?? []).filter(isUserMessage);
        if (userMessages.length > 0) {
          finalizeTurn(record, entry, record.turn);
          record.turn = newTurn();
          record.sessionId = agent?.session?.id ?? record.sessionId;
          sessionFor(record, entry).prompts += userMessages.length;
          entry.dirty = true;
          flush(entry);
        }
      }
    } catch (error) {
      log(ctx, "warn", "pre-step bookkeeping failed", error);
    }

    const decision = await next();

    try {
      if (record && !record.disabled && !record.factsInjected) {
        record.factsInjected = true;
        if (config.microskills === "on" && decision?.kind === "enter") {
          const text = renderFacts(deriveFacts(repoEntry(record.repo).state));
          const notice = text ? makeNotice(text, "tokeneconomizer micro-skills") : null;
          if (notice) return { ...decision, messages: [notice, ...decision.messages] };
        }
      }
    } catch (error) {
      log(ctx, "warn", "micro-skill injection failed", error);
    }

    return decision;
  });

  ctx.on("tools/post-execute", async (exec, result, next) => {
    let pending = null;
    try {
      const record = ensureAgent(exec?.agent);
      if (!record.disabled) {
        const entry = repoEntry(record.repo);
        const session = sessionFor(record, entry);
        recordToolUse(session, exec.name);

        const isError = result?.isError === true;
        let sig = null;
        if (isError) {
          const text = failureText(result);
          sig = failureSignature(exec.name, text);
          recordFailureSignature(session, sig, text);
        }
        entry.dirty = true;
        scheduleSave(entry);

        observeToolResult(record.turn, { isError, sig });
        const action = decideIntervention(record.turn, config, callEnvelope(entry.state, config));
        if (action) {
          const text = action.kind === "nudge" ? nudgeText(action) : stopText(action);
          const summary = action.kind === "nudge" ? "tokeneconomizer loop guard" : "tokeneconomizer loop guard (stop)";
          pending = makeNotice(text, summary);
        }
      }
    } catch (error) {
      log(ctx, "warn", "post-execute bookkeeping failed", error);
    }

    const decision = await next();
    if (!pending) return decision;
    return { ...decision, additionalContexts: [pending, ...(decision?.additionalContexts ?? [])] };
  });

  ctx.on("agent/disposed", ({ agent }) => {
    try {
      const record = agents.get(agent);
      if (!record) return;
      agents.delete(agent);
      if (record.disabled || !record.repo) return;
      const entry = repos.get(record.repo);
      if (!entry) return;
      finalizeTurn(record, entry, record.turn);
      flush(entry);
    } catch (error) {
      log(ctx, "warn", "disposal failed", error);
    }
  });

  ctx.effect?.(() => () => {
    for (const entry of repos.values()) flush(entry);
  });

  log(ctx, "info", `active (${JSON.stringify(describableConfig(config))})`);
}
