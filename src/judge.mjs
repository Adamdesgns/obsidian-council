// src/judge.mjs — Deliberation judge: is this answer responsive to that question?
//
// Two tiers, in order:
//   1. Free local screen (screenAnswer). Deterministic heuristics, no model,
//      no network. Decides the obvious: empty, refusal, error output, questions
//      back, a yes/no question answered yes/no with a reason, or a substantive
//      answer that covers the question's own terms.
//   2. Typed model (the "Jev" client) ONLY when the screen says "uncertain".
//      The client returns a TypedVerdict { verdict, confidence, reason } which
//      is validated before it is trusted. A malformed or failing client can
//      never promote an answer to "responsive"; it leaves the run uncertain.
//
// There is no live client in this repo. Tests use src/testutil/fake-jev.mjs.
// The judge itself never opens a socket, never reads a key, never touches the
// clock: given the same inputs and the same client it gives the same verdict.

export const VERDICTS = ["responsive", "unresponsive", "uncertain"];

const STOPWORDS = new Set([
  "about", "after", "again", "also", "and", "any", "are", "because", "been", "before", "being",
  "between", "both", "but", "can", "could", "did", "does", "doing", "down", "during", "each",
  "few", "for", "from", "further", "had", "has", "have", "having", "here", "how", "into", "its",
  "just", "more", "most", "not", "now", "off", "once", "only", "other", "our", "out", "over",
  "own", "please", "same", "should", "some", "such", "than", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "those", "through", "under", "until", "very", "was",
  "were", "what", "when", "where", "which", "while", "who", "whom", "why", "will", "with",
  "would", "you", "your", "write", "give", "make", "tell", "explain", "describe", "list",
]);

const REFUSAL = /^\s*(?:i['’]?m\s+sorry|sorry|i\s+(?:can['’]?t|cannot|am\s+unable|['’]m\s+unable|won['’]?t|will\s+not)|as\s+an\s+ai|unfortunately,?\s+i\s+(?:can['’]?t|cannot))/i;
const ERROR_LINE = /^\s*(?:error|exception|traceback|fatal|panic|uncaught)\b/i;
const YES_NO_QUESTION = /^\s*(?:should|is|are|does|do|can|could|will|would|has|have|had|did|was|were|must|may|shall)\b/i;
const DIRECT_ANSWER = /^\s*(?:yes|no|nope|yep|correct|incorrect|true|false)\b[.,:;!\s-]+\S/i;

function words(text) {
  return String(text)
    .toLowerCase()
    .replace(/[`*_#>|]/g, " ")
    .split(/[^a-z0-9'-]+/)
    .filter(Boolean);
}

function stem(w) {
  // Tiny, deterministic suffix strip so "prints"/"printing"/"printed" meet "print".
  return w.replace(/'s$/, "").replace(/(ing|ed|es|s)$/, (m, _s, off) => (off >= 3 ? "" : m));
}

function contentTerms(text) {
  const out = new Set();
  for (const w of words(text)) {
    if (w.length < 4 || STOPWORDS.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}

function looksLikeErrorJson(text) {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return false;
  try {
    const o = JSON.parse(t);
    const items = Array.isArray(o) ? o : [o];
    return items.some((x) => x && (x.type === "error" || typeof x.error === "string"));
  } catch {
    return false;
  }
}

function onlyQuestions(text) {
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!sentences.length) return false;
  return sentences.every((s) => s.endsWith("?"));
}

/**
 * Free local screen. Returns { verdict, reason, by: "screen", score }.
 * Never throws on bad input; a non-string answer is treated as empty.
 */
export function screenAnswer(question, answer, opts = {}) {
  const minWords = opts.minWords ?? 3;
  const minOverlap = opts.minOverlap ?? 0.5;
  const q = typeof question === "string" ? question : "";
  const a = typeof answer === "string" ? answer.trim() : "";
  const done = (verdict, reason, score = {}) => ({ verdict, reason, by: "screen", score });

  if (!a || a === "(empty)") return done("unresponsive", "empty", { words: 0 });
  if (ERROR_LINE.test(a) || looksLikeErrorJson(a)) return done("unresponsive", "error_output", { words: words(a).length });
  if (REFUSAL.test(a)) return done("unresponsive", "refusal", { words: words(a).length });
  if (onlyQuestions(a)) return done("unresponsive", "question_back", { words: words(a).length });

  const aWords = words(a);
  if (aWords.length < minWords) return done("uncertain", "too_short", { words: aWords.length });
  if (YES_NO_QUESTION.test(q) && DIRECT_ANSWER.test(a) && aWords.length >= minWords + 1) {
    return done("responsive", "direct_answer", { words: aWords.length });
  }

  const qTerms = contentTerms(q);
  const aTerms = contentTerms(a);
  if (!qTerms.size) return done("uncertain", "no_question_terms", { words: aWords.length, overlap: 0 });
  let shared = 0;
  for (const t of qTerms) if (aTerms.has(t)) shared++;
  const overlap = shared / qTerms.size;
  const score = { words: aWords.length, overlap: Number(overlap.toFixed(3)), shared, question_terms: qTerms.size };

  if (overlap >= minOverlap) return done("responsive", "keyword_overlap", score);
  if (shared === 0) return done("uncertain", "no_overlap", score);
  return done("uncertain", "low_overlap", score);
}

/** Validate a TypedVerdict from the typed client before trusting it. */
export function validateTypedVerdict(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, why: "not_object" };
  if (!VERDICTS.includes(v.verdict)) return { ok: false, why: "bad_verdict" };
  if (typeof v.confidence !== "number" || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) {
    return { ok: false, why: "bad_confidence" };
  }
  if (typeof v.reason !== "string" || !v.reason.trim()) return { ok: false, why: "bad_reason" };
  return { ok: true };
}

/**
 * createJudge({ client?, screen?, maxTypedCalls? })
 *   client: { judge({ question, answer, screen }) -> Promise<TypedVerdict> } or absent.
 *   judge(question, answer) -> Promise<Verdict>; never rejects.
 */
export function createJudge(opts = {}) {
  const client = opts.client || null;
  const screen = opts.screen || screenAnswer;
  const maxTypedCalls = opts.maxTypedCalls ?? Infinity;
  const stats = { screened: 0, typed: 0, typed_invalid: 0, typed_error: 0 };

  async function judge(question, answer) {
    const s = screen(question, answer, opts.screenOpts);
    stats.screened++;
    if (s.verdict !== "uncertain") return s;

    if (!client) return { ...s, needs_typed: true };
    if (stats.typed >= maxTypedCalls) {
      return { verdict: "uncertain", reason: "typed_budget", by: "screen", screen: s, needs_typed: true };
    }

    stats.typed++;
    let typed;
    try {
      typed = await client.judge({ question, answer, screen: s });
    } catch (e) {
      stats.typed_error++;
      return { verdict: "uncertain", reason: "typed_error", by: "typed", screen: s, error: String(e && e.message || e) };
    }
    const valid = validateTypedVerdict(typed);
    if (!valid.ok) {
      stats.typed_invalid++;
      return { verdict: "uncertain", reason: "typed_invalid", by: "typed", screen: s, detail: valid.why };
    }
    return { verdict: typed.verdict, reason: typed.reason, confidence: typed.confidence, by: "typed", screen: s };
  }

  return { judge, stats: () => ({ ...stats }) };
}
