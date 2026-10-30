import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfig, DEFAULTS } from "./config.mjs";
import { repoKey, emptyState, newSessionRecord, recordFailureSignature } from "./store.mjs";
import { failureSignature, deriveFacts, renderFacts } from "./microskills.mjs";
import { planPrune } from "./toolprune.mjs";
import { newTurn, observeToolResult, callEnvelope, decideIntervention } from "./loopguard.mjs";

test("config keeps defaults and clamps bad values", () => {
  const defaults = resolveConfig({}, {});
  assert.equal(defaults.toolprune, "on");
  assert.equal(defaults.microskills, "off");
  assert.equal(defaults.loopguard_backstop_mult, DEFAULTS.loopguard_backstop_mult);

  assert.equal(resolveConfig({}, { TE_DISABLE: "1" }).enabled, false);
  assert.equal(resolveConfig({}, { TE_TOOLPRUNE: "off" }).toolprune, "off");
  // An unknown mode never silently becomes a working-but-wrong state.
  assert.equal(resolveConfig({ toolprune: "sometimes" }, {}).toolprune, "on");
  assert.equal(resolveConfig({ toolprune_evidence: 0 }, {}).toolprune_evidence, 10);
  assert.equal(resolveConfig({ toolprune_evidence: 4 }, {}).toolprune_evidence, 4);
  assert.equal(resolveConfig({}, { TE_TOOLPRUNE: "propose" }).toolprune, "propose");
});

test("TE_DISABLE is a kill switch, not a default", () => {
  // A config block that says enabled: true must not outrun the environment switch,
  // or a user with a stuck session has no way out.
  assert.equal(resolveConfig({ enabled: true }, { TE_DISABLE: "1" }).enabled, false);
  assert.equal(resolveConfig({}, {}).enabled, true);
});

test("repo keys separate directories and stay stable", () => {
  const a = repoKey(process.cwd());
  const b = repoKey(process.cwd());
  assert.equal(a.key, b.key);
  assert.equal(repoKey("/tmp").key === a.key, false);
});

test("failure signatures collapse run-specific detail", () => {
  const one = failureSignature("bash", "ModuleNotFoundError: No module named 'pandas' at /home/a/x.py:12 after 3 tries");
  const two = failureSignature("bash", "ModuleNotFoundError: No module named 'pandas' at /home/b/y.py:98 after 41 tries");
  assert.equal(one, two);
  assert.notEqual(one, failureSignature("bash", "permission denied"));
});

test("a fact needs two sessions; one bad turn is noise", () => {
  const state = emptyState("/repo");
  const first = newSessionRecord("s1");
  const second = newSessionRecord("s2");
  const once = newSessionRecord("s3");
  recordFailureSignature(first, "bash: command not found", "command not found");
  recordFailureSignature(second, "bash: command not found", "command not found");
  recordFailureSignature(once, "bash: permission denied", "permission denied");
  state.sessions.push(first, second, once);

  const facts = deriveFacts(state);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].sig, "bash: command not found");
  assert.equal(facts[0].sessions, 2);
  assert.match(renderFacts(facts), /failed in 2 earlier sessions/);
  assert.equal(renderFacts([]), "");
});

test("tool pruning needs sessions of evidence and never touches a used tool", () => {
  const config = resolveConfig({}, {});
  const state = emptyState("/repo");
  for (let i = 0; i < 5; i += 1) {
    const session = newSessionRecord(`s${i}`);
    session.prompts = 3;
    session.tools = { bash: 2 };
    state.sessions.push(session);
  }
  const plan = planPrune(state, ["bash", "present", "subagent"], config);
  assert.deepEqual(plan.deny.sort(), ["present", "subagent"]);

  // One session is not evidence of anything yet.
  const thin = emptyState("/repo");
  const only = newSessionRecord("s0");
  only.prompts = 50;
  thin.sessions.push(only);
  assert.deepEqual(planPrune(thin, ["bash"], config).deny, []);
});

test("a tool the repository called once is never pruned, however long the window", () => {
  const config = resolveConfig({}, {});
  const state = emptyState("/repo");
  const early = newSessionRecord("old");
  early.prompts = 1;
  early.tools = { present: 1 };
  state.sessions.push(early);
  for (let i = 0; i < 5; i += 1) {
    const session = newSessionRecord(`s${i}`);
    session.prompts = 3;
    session.tools = { bash: 2 };
    state.sessions.push(session);
  }
  // `present` has been unused for five sessions, but it did work once: upstream
  // keeps it, and so does this port.
  assert.deepEqual(planPrune(state, ["bash", "present"], config).deny, []);
});

test("loop guard redirects once on a repeated failure, then stops", () => {
  const config = resolveConfig({}, {});
  const turn = newTurn();
  const sig = "bash: command not found";

  assert.equal(decideIntervention(turn, config, null), null);
  observeToolResult(turn, { isError: true, sig });
  observeToolResult(turn, { isError: true, sig });
  assert.equal(decideIntervention(turn, config, null), null, "two repeats is still normal debugging");

  observeToolResult(turn, { isError: true, sig });
  assert.equal(decideIntervention(turn, config, null).kind, "nudge");
  observeToolResult(turn, { isError: true, sig });
  assert.equal(decideIntervention(turn, config, null).kind, "stop");
  observeToolResult(turn, { isError: true, sig });
  assert.equal(decideIntervention(turn, config, null), null, "the guard never nags");

  // Disabled means silent, whatever the evidence.
  const off = resolveConfig({ loopguard: "off" }, {});
  const hot = newTurn();
  for (let i = 0; i < 9; i += 1) observeToolResult(hot, { isError: true, sig });
  assert.equal(decideIntervention(hot, off, null), null);
});

test("the call-count backstop needs a trusted envelope", () => {
  const config = resolveConfig({}, {});
  const state = emptyState("/repo");
  for (let i = 0; i < 4; i += 1) {
    const session = newSessionRecord(`s${i}`);
    session.turns = [{ calls: 4, errors: 0, wellEnded: 1 }];
    state.sessions.push(session);
  }
  assert.equal(callEnvelope(state, config), null, "four samples is below min_samples=5");

  const fifth = newSessionRecord("s5");
  fifth.turns = [{ calls: 4, errors: 0, wellEnded: 1 }];
  state.sessions.push(fifth);
  assert.equal(callEnvelope(state, config), 4);

  const turn = newTurn();
  for (let i = 0; i < 12; i += 1) {
    // The last call must be a failure: the guard never speaks on a passing call.
    observeToolResult(turn, { isError: i % 2 === 1, sig: `bash: variant ${i}` });
  }
  assert.equal(decideIntervention(turn, config, 4).kind, "nudge");
  // Same turn without an envelope is quiet: a long turn alone is not a loop.
  assert.equal(decideIntervention(newTurn(), config, null), null);
});
