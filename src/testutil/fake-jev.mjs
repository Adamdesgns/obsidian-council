// src/testutil/fake-jev.mjs — deterministic stand-in for the TypeSafe client.
// Tests must never touch the network and must never need a key.

/**
 * @param {object} script  optional canned answers, keyed by a substring of state.reply
 * @param {object} opts    { latencyMs, defaultDecision, defaultConfidence }
 */
export function createFakeJev(script = {}, opts = {}) {
  const calls = [];
  const latency = opts.latencyMs ?? 0;

  async function evaluate({ model, state, questions }) {
    calls.push({ model, state, questions });
    if (latency) await new Promise((r) => setTimeout(r, latency));

    const reply = String(state?.reply || "");
    const hit = Object.keys(script).find((k) => reply.includes(k));
    if (hit) return { model, ...script[hit] };

    const decision = opts.defaultDecision || "UNCLEAR";
    const confidence = opts.defaultConfidence ?? 0.4;
    return {
      model,
      responsive: {
        choice: decision,
        confidence,
        probabilities: { RESPONSIVE: 0.3, NOT_RESPONSIVE: 0.3, UNCLEAR: 0.4 },
      },
      cites_specifics: { probability: 0.5 },
      claims_nothing_received: { probability: 0.1 },
    };
  }

  return { evaluate, calls, callCount: () => calls.length };
}

/** Shape a real answer takes, for readability in tests. */
export function answer(decision, confidence, extra = {}) {
  return {
    responsive: { choice: decision, confidence, probabilities: { [decision]: confidence } },
    cites_specifics: { probability: extra.cites ?? 0.8 },
    claims_nothing_received: { probability: extra.claimsNothing ?? 0.05 },
  };
}
