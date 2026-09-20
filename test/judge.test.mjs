// test/judge.test.mjs — no network, no key, no sqlite. node --test test/judge.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createJudge, localScreen, overlapRatio, VERDICTS } from "../src/judge.mjs";
import { createFakeJev, answer } from "../src/testutil/fake-jev.mjs";

// The real 2026-09-18 exchange, trimmed.
const PLAN = `1. Post one build-in-public thread each morning with a screenshot of the actual record.
2. Reply to ten accounts in the local services niche before noon.
3. Ship one small tool per week and post the failure log with it.
4. Send a Friday recap to the email list with the week's numbers.
5. Track replies-to-followers ratio weekly and cut whatever underperforms.`;

const GROK_CONFUSED = `Codex has not posted a plan yet, so there is nothing to poke.
The instructions here are also vague about what counts as success.`;

const GROK_REAL = `The plan is a generic be-active-on-Twitter checklist. It will produce posts, not clients.
Ten replies before noon is activity, not targeting. The Friday recap has no ask in it.`;

test("the routing bug is caught for free, with no model call", async () => {
  const fake = createFakeJev();
  const j = createJudge({ jev: fake });
  const v = await j.judge({ received: PLAN, reply: GROK_CONFUSED, member: "grok" });

  assert.equal(v.decision, "NOT_RESPONSIVE");
  assert.equal(v.via, "local");
  assert.equal(v.rule, "claims_absence_despite_material");
  assert.ok(v.confidence > 0.9);
  assert.equal(fake.callCount(), 0, "must not spend on a case the screen already decided");
});

test("a real critique reads as responsive, also for free", async () => {
  const fake = createFakeJev();
  const j = createJudge({ jev: fake });
  const v = await j.judge({ received: PLAN, reply: GROK_REAL, member: "grok" });

  assert.equal(v.decision, "RESPONSIVE");
  assert.equal(v.via, "local");
  assert.equal(fake.callCount(), 0);
});

test("an empty reply is not responsive", async () => {
  const j = createJudge();
  const v = await j.judge({ received: PLAN, reply: "   " });
  assert.equal(v.decision, "NOT_RESPONSIVE");
  assert.equal(v.rule, "empty_reply");
});

test("no material sent means the judge declines rather than blaming the member", async () => {
  const j = createJudge();
  const v = await j.judge({ received: "", reply: GROK_REAL });
  assert.equal(v.decision, "UNCLEAR");
  assert.equal(v.rule, "no_material_sent");
});

test("with no client injected, an inconclusive case spends nothing and escalates", async () => {
  const j = createJudge(); // no jev
  const v = await j.judge({ received: PLAN, reply: "Sure. Looks fine to me overall." });
  assert.equal(v.needsJev, true);
  assert.equal(v.escalate, true);
  assert.equal(v.via, "local");
});

test("inconclusive cases go to the typed model exactly once", async () => {
  const fake = createFakeJev({ "Looks fine": answer("NOT_RESPONSIVE", 0.88) });
  const j = createJudge({ jev: fake });
  const v = await j.judge({ received: PLAN, reply: "Sure. Looks fine to me overall." });

  assert.equal(v.via, "jev");
  assert.equal(v.decision, "NOT_RESPONSIVE");
  assert.equal(v.confidence, 0.88);
  assert.equal(fake.callCount(), 1);
  assert.equal(Object.keys(fake.calls[0].questions).length, 3, "all questions batched in one call");
});

test("low confidence escalates instead of acting", async () => {
  const fake = createFakeJev({ "Looks fine": answer("RESPONSIVE", 0.31) });
  const j = createJudge({ jev: fake });
  const v = await j.judge({ received: PLAN, reply: "Sure. Looks fine to me overall." });
  assert.equal(v.escalate, true);
});

test("a typed verdict still carries what it looked at", async () => {
  const fake = createFakeJev({ "Looks fine": answer("RESPONSIVE", 0.9) });
  const j = createJudge({ jev: fake });
  const v = await j.judge({ received: PLAN, reply: "Sure. Looks fine to me overall." });

  assert.ok(v.evidence.state.material.includes("Friday recap"));
  assert.ok(v.evidence.questions.responsive);
  assert.equal(typeof v.evidence.cites_specifics, "number");
});

test("the model returns only listed options", async () => {
  const fake = createFakeJev({ "x": { responsive: { choice: "MAYBE_LATER", confidence: 0.99 } } });
  const j = createJudge({ jev: fake });
  const v = await j.judge({ received: PLAN, reply: "x y z nothing in common at all here" });
  assert.ok(VERDICTS.includes(v.decision), "an off-schema answer must not leak through");
});

test("a client that throws never takes the judge down: UNCLEAR, escalated, recorded", async () => {
  const fake = { calls: [], async evaluate() { throw new Error("socket hang up"); } };
  const j = createJudge({ jev: fake });
  const v = await j.judge({ received: PLAN, reply: "Sure. Looks fine to me overall." });
  assert.equal(v.decision, "UNCLEAR");
  assert.equal(v.via, "jev");
  assert.equal(v.rule, "typed_error");
  assert.equal(v.escalate, true);
  assert.match(v.evidence.error, /socket hang up/);
  assert.equal(j.stats().byRule.typed_error, 1);
});

test("a malformed confidence cannot slip a verdict past the escalation gate", async () => {
  for (const confidence of ["high", NaN, -0.2, 1.7, undefined]) {
    const fake = createFakeJev({ "Looks fine": { responsive: { choice: "RESPONSIVE", confidence } } });
    const j = createJudge({ jev: fake });
    const v = await j.judge({ received: PLAN, reply: "Sure. Looks fine to me overall." });
    assert.equal(v.decision, "UNCLEAR", `confidence=${String(confidence)}`);
    assert.equal(v.rule, "typed_invalid");
    assert.equal(v.escalate, true);
    assert.equal(v.confidence, 0);
  }
});

test("an off-schema choice is also typed_invalid and escalates", async () => {
  const fake = createFakeJev({ "x": { responsive: { choice: "MAYBE_LATER", confidence: 0.99 } } });
  const j = createJudge({ jev: fake });
  const v = await j.judge({ received: PLAN, reply: "x y z nothing in common at all here" });
  assert.equal(v.decision, "UNCLEAR");
  assert.equal(v.rule, "typed_invalid");
  assert.equal(v.escalate, true);
});

test("maxJevCalls caps typed spend; past the cap the judge declines instead of calling", async () => {
  const fake = createFakeJev({ "Looks fine": answer("RESPONSIVE", 0.9) });
  const j = createJudge({ jev: fake, maxJevCalls: 1 });
  const first = await j.judge({ received: PLAN, reply: "Sure. Looks fine to me overall." });
  const second = await j.judge({ received: PLAN, reply: "Sure. Looks fine to me overall." });
  assert.equal(first.via, "jev");
  assert.equal(second.decision, "UNCLEAR");
  assert.equal(second.rule, "jev_budget");
  assert.equal(second.needsJev, true);
  assert.equal(second.escalate, true);
  assert.equal(fake.callCount(), 1);
  assert.equal(j.stats().jev, 1);
});

test("stats report how much of the traffic stayed free", async () => {
  const fake = createFakeJev();
  const j = createJudge({ jev: fake });
  await j.judge({ received: PLAN, reply: GROK_CONFUSED });
  await j.judge({ received: PLAN, reply: GROK_REAL });
  await j.judge({ received: PLAN, reply: "Sure. Looks fine to me overall." });

  const s = j.stats();
  assert.equal(s.total, 3);
  assert.equal(s.local, 2);
  assert.equal(s.jev, 1);
});

test("overlap ratio behaves", () => {
  assert.equal(overlapRatio("", "anything"), 0);
  assert.ok(overlapRatio(PLAN, PLAN) > 0.9);
  assert.ok(overlapRatio(PLAN, "completely unrelated wording") < 0.05);
});

test("localScreen returns null when it genuinely cannot tell", () => {
  const r = localScreen("short bit of material here about pipes", "I think the third point needs work.");
  assert.equal(r, null);
});
