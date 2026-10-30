import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { apply } from "./index.mjs";
import { resolveConfig } from "./config.mjs";
import { loadState, saveState, emptyState, newSessionRecord, recordFailureSignature } from "./store.mjs";

/**
 * End-to-end wiring check: drive the plugin's real event handlers with a fake
 * context, over a real state directory. Unit tests prove the rules; this proves
 * the plugin actually reads them on the events DSH emits.
 */
function seededRepo(workDir, stateDir) {
  const config = resolveConfig({ stateDir }, {});
  const state = emptyState(workDir);
  for (let i = 0; i < 5; i += 1) {
    const session = newSessionRecord(`old-${i}`);
    session.prompts = 3;
    session.tools = { bash: 2 };
    if (i < 2) recordFailureSignature(session, "bash: command not found", "command not found: pytest");
    state.sessions.push(session);
  }
  assert.equal(saveState(config, workDir, state), true);
  return config;
}

function fakeContext() {
  const handlers = new Map();
  const effects = [];
  const logs = [];
  const ctx = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    effect(factory) {
      effects.push(factory);
    },
    logger: {
      info: (...args) => logs.push(["info", ...args]),
      warn: (...args) => logs.push(["warn", ...args]),
    },
  };
  const fire = async (event, ...args) => {
    const list = handlers.get(event) ?? [];
    const results = [];
    for (const handler of list) results.push(await handler(...args));
    return results.at(-1);
  };
  return { ctx, fire, logs, effects };
}

function fakeAgent(workDir, restricted) {
  const tools = {
    schemas: () => [{ name: "bash" }, { name: "present" }, { name: "subagent" }],
    restrict: (filter) => {
      restricted.push(filter);
      return () => {};
    },
  };
  return { session: { id: "live-1", header: { cwd: workDir } }, ctx: { tools } };
}

test("the plugin turns a real repository history into pruning, facts, a redirect, and saved state", async () => {
  const root = mkdtempSync(join(tmpdir(), "te-wiring-"));
  try {
    const workDir = join(root, "repo");
    const stateDir = join(root, "state");
    const config = seededRepo(workDir, stateDir);

    const { ctx, fire, logs } = fakeContext();
    apply(ctx, { stateDir, microskills: "on" });

    const restricted = [];
    const agent = fakeAgent(workDir, restricted);

    await fire("agent/created", { agent });
    assert.equal(restricted.length, 1, "pruning must run when the agent is created");
    assert.deepEqual(restricted[0].deny.sort(), ["present", "subagent"]);
    assert.ok(restricted[0].deny.includes("bash") === false, "a used tool is never hidden");

    const userMessage = { role: "user", content: [{ type: "text", text: "fix the build" }], source: { kind: "user" } };
    const decision = await fire(
      "agent/pre-step",
      { agent, messages: [userMessage] },
      async () => ({ kind: "enter", messages: [userMessage] }),
    );
    assert.ok(decision.messages[0].source.kind === "tokeneconomizer", "facts are injected before the user turn");
    assert.match(decision.messages[0].content[0].text, /failed in 2 earlier sessions/);
    assert.equal(decision.messages[1], userMessage, "the user message is preserved and follows the notice");

    const second = await fire(
      "agent/pre-step",
      { agent, messages: [userMessage] },
      async () => ({ kind: "enter", messages: [userMessage] }),
    );
    assert.equal(second.messages.length, 1, "facts are injected once per session, not once per step");

    const failure = { isError: true, error: { message: "command not found: pytest" }, content: [] };
    const exec = { agent, name: "bash", arguments: { command: "pytest" } };
    let last = null;
    for (let i = 0; i < 3; i += 1) {
      last = await fire("tools/post-execute", exec, failure, async () => ({ kind: "accept" }));
    }
    assert.equal(last.additionalContexts?.length, 1, "the third identical failure triggers one redirect");
    assert.match(last.additionalContexts[0].content[0].text, /loop guard/);

    const healthy = await fire("tools/post-execute", { ...exec, name: "bash" }, { isError: false, value: "ok", content: [] }, async () => ({ kind: "accept" }));
    assert.equal(healthy.additionalContexts, undefined, "a passing call keeps the turn quiet");

    await fire("agent/disposed", { agent });

    const saved = loadState(config, workDir);
    const live = saved.sessions.find((session) => session.id === "live-1");
    assert.ok(live, "the live session was persisted on disposal");
    assert.equal(live.prompts, 2);
    assert.equal(live.tools.bash, 4);
    assert.equal(Object.values(live.failures)[0]?.count, 3, "one signature, counted three times");
    assert.match(Object.keys(live.failures)[0], /^bash: command not found/);
    assert.deepEqual(saved.deny.tools.sort(), ["present", "subagent"]);
    assert.ok(logs.some((entry) => String(entry[1]).includes("hid 2 unused tool")), "the prune is reported, not silent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subagent sessions and disabled pruning leave the loop untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "te-wiring-"));
  try {
    const workDir = join(root, "repo");
    const stateDir = join(root, "state");
    seededRepo(workDir, stateDir);

    const { ctx, fire } = fakeContext();
    apply(ctx, { stateDir, microskills: "on" });

    const restricted = [];
    const subagent = {
      session: { id: "child-1", header: { cwd: workDir, origin: "subagent" } },
      ctx: { tools: { schemas: () => [{ name: "bash" }], restrict: (f) => restricted.push(f) } },
    };
    await fire("agent/created", { agent: subagent });
    const decision = await fire(
      "agent/pre-step",
      { agent: subagent, messages: [{ source: { kind: "user" } }] },
      async () => ({ kind: "enter", messages: [] }),
    );
    assert.deepEqual(restricted, []);
    assert.equal(decision.messages.length, 0, "delegated agents get no facts and no pruning");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
