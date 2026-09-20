// src/testutil/fake-jev.mjs — deterministic stand-in for the Jev typed-verdict client.
//
// The real client (not in this repo yet) would ask a typed model for a
// TypedVerdict { verdict, confidence, reason }. This fake is in-memory only:
// no network, no keys, no clock. Tests script it and inspect `calls`.
//
//   createFakeJev()                        -> always { responsive, 0.9, "fake:default" }
//   createFakeJev({ script: [v1, v2] })    -> returns v1, v2, then throws "script exhausted"
//   createFakeJev({ script: (req) => v })  -> computed per call
//   createFakeJev({ mode: "malformed" })   -> returns an object that fails validation
//   createFakeJev({ mode: "throw" })       -> rejects every call
export function createFakeJev(opts = {}) {
  const calls = [];
  const script = opts.script;
  const mode = opts.mode || "script";
  let cursor = 0;

  async function judge(req) {
    calls.push({ question: req?.question, answer: req?.answer, screen: req?.screen ?? null });
    if (mode === "throw") throw new Error(opts.error || "fake-jev: refused");
    if (mode === "malformed") return opts.malformed ?? { verdict: "maybe", confidence: "high" };
    if (typeof script === "function") return script(req, calls.length);
    if (Array.isArray(script)) {
      if (cursor >= script.length) throw new Error("fake-jev: script exhausted");
      return script[cursor++];
    }
    return { verdict: "responsive", confidence: 0.9, reason: "fake:default" };
  }

  return { kind: "fake-jev", judge, calls };
}
