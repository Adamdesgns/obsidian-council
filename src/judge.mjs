// src/judge.mjs — responsiveness judge. Cheap local screen first; typed model only when needed.
//
// Why this exists: on 2026-09-18 a reviewer critiqued a plan it had never received
// (parallel delivery + directed chain raced). The reply was visibly confused, so it
// was caught by eye in seconds. That only works while members emit prose. Any typed
// judge bolted on later will return a well-formed answer for the same bug, so the
// detection has to be explicit.
//
// Contract: NOTHING here touches the network unless opts.jev is injected.
// With no client, the judge returns needsJev and spends nothing. Zero npm deps.

export const VERDICTS = ["RESPONSIVE", "NOT_RESPONSIVE", "UNCLEAR"];

// Phrases a member uses when it believes it received nothing.
const CLAIMS_ABSENCE = [
  /\bhas\s+not\s+(yet\s+)?(posted|provided|shared|sent|written)\b/i,
  /\bhasn'?t\s+(yet\s+)?(posted|provided|shared|sent|written)\b/i,
  /\bnothing\s+to\s+(poke|critique|review|check|go\s+on)\b/i,
  /\bno\s+(plan|draft|code|content|proposal)\s+(was\s+)?(posted|provided|received|attached|given)\b/i,
  /\bdid\s+not\s+receive\b/i,
  /\bi\s+(don'?t|do\s+not)\s+see\s+(a|any|the)\s+(plan|draft|proposal|code)\b/i,
  /\bwaiting\s+(for|on)\s+the\s+(plan|draft|proposal)\b/i,
  /\bonce\s+(the\s+)?(plan|draft)\s+is\s+(posted|shared|available)\b/i,
];

const STOP = new Set(("a an the and or but if then than that this these those of to in on for with as at by from is are was were be been being it its "
  + "i you he she they we me him her them us my your his their our not no do does did doing have has had will would can could should shall may might must "
  + "so such into over under again further once here there when where why how all any both each few more most other some only own same too very just now")
  .split(/\s+/));

/** Content words, lowercased, de-duplicated. Short and numeric-bearing tokens are kept. */
export function contentTokens(text) {
  const out = new Set();
  for (const raw of String(text || "").toLowerCase().match(/[a-z0-9][a-z0-9._/-]*/g) || []) {
    if (raw.length < 3 && !/\d/.test(raw)) continue;
    if (STOP.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/** Share of the received material's distinctive tokens that the reply echoes back. */
export function overlapRatio(received, reply) {
  return overlap(received, reply).ratio;
}

/** Ratio plus the raw hit count, because a ratio over a tiny vocabulary lies. */
export function overlap(received, reply) {
  const a = contentTokens(received);
  const b = contentTokens(reply);
  if (a.size === 0) return { ratio: 0, hits: 0, size: 0 };
  let hits = 0;
  for (const t of a) if (b.has(t)) hits++;
  return { ratio: hits / a.size, hits, size: a.size };
}

/**
 * Free local screen. Returns a verdict only when it is confident; otherwise null.
 * This is the path that should handle the overwhelming majority of traffic.
 */
// Measured on real Council traffic, not guessed: a genuine critique of a 42-token plan
// echoed only 12% of its tokens, and a half-engaged reply echoed 9.5%. Overlap is a
// strong NEGATIVE signal and a weak positive one, so the positive rule also demands an
// absolute hit count, and the negative rule only fires on a reply long enough to have
// engaged if it wanted to. Everything between them is left for the typed model.
export function localScreen(received, reply, cfg = {}) {
  const hi = cfg.overlapHigh ?? 0.10;
  const minHits = cfg.minHits ?? 4;
  const substantialReply = cfg.substantialReply ?? 120;
  const substantialMaterial = cfg.substantialMaterial ?? 200;
  const text = String(reply || "");
  const material = String(received || "");

  if (!text.trim()) {
    return { decision: "NOT_RESPONSIVE", confidence: 1, via: "local", rule: "empty_reply" };
  }
  if (!material.trim()) {
    // Nothing was sent, so a reply cannot be unresponsive to it.
    return { decision: "UNCLEAR", confidence: 1, via: "local", rule: "no_material_sent" };
  }
  for (const re of CLAIMS_ABSENCE) {
    if (re.test(text)) {
      // The member says it got nothing, but material was delivered. This is the bug.
      return {
        decision: "NOT_RESPONSIVE",
        confidence: 0.97,
        via: "local",
        rule: "claims_absence_despite_material",
        detail: String(text.match(re)?.[0] || "").slice(0, 120),
      };
    }
  }
  const { ratio, hits } = overlap(material, text);
  if (ratio >= hi && hits >= minHits) {
    return { decision: "RESPONSIVE", confidence: 0.8, via: "local", rule: "engages_material", ratio, hits };
  }
  if (hits === 0 && text.length >= substantialReply && material.length >= substantialMaterial) {
    // Wrote plenty, echoed nothing. Not a short reply we are being unfair to.
    return { decision: "NOT_RESPONSIVE", confidence: 0.75, via: "local", rule: "wrote_past_material", ratio, hits };
  }
  return null; // inconclusive -> typed model, if one is wired
}

/** The typed questions, asked together in one call (speculative fan-out). */
export function buildQuestions() {
  return {
    responsive: {
      type: "choice",
      instructions:
        "The state contains MATERIAL the member was sent and the REPLY it produced. "
        + "Choose RESPONSIVE if the reply engages with the material's actual content. "
        + "Choose NOT_RESPONSIVE if the reply ignores it, answers something else, or claims no material was provided. "
        + "Choose UNCLEAR if you cannot tell.",
      options: VERDICTS,
    },
    cites_specifics: {
      type: "noul",
      instructions: "Does the reply refer to at least one specific detail that appears in the material?",
    },
    claims_nothing_received: {
      type: "noul",
      instructions: "Does the reply state or imply that no material was provided to it?",
    },
  };
}

export function createJudge(opts = {}) {
  const jev = opts.jev || null;                  // { evaluate({model, state, questions}) }
  const model = opts.model || "jev-1.13.0";      // pin: thresholds are tuned per version
  const escalateBelow = opts.escalateBelow ?? 0.5;
  const maxJevCalls = opts.maxJevCalls ?? Infinity; // typed spend cap for this judge's lifetime
  const cfg = opts.screen || {};
  const stats = { total: 0, local: 0, jev: 0, escalated: 0, byRule: Object.create(null) };

  function note(r) {
    stats.total++;
    if (r.via === "local") stats.local++;
    if (r.via === "jev") stats.jev++;
    if (r.escalate) stats.escalated++;
    const k = r.rule || r.via;
    stats.byRule[k] = (stats.byRule[k] || 0) + 1;
    return r;
  }

  /**
   * @param {{received:string, reply:string, member?:string, messageId?:string}} input
   * @returns {Promise<object>} verdict record, always safe to persist
   */
  async function judge(input) {
    const { received, reply, member = null, messageId = null } = input || {};
    const local = localScreen(received, reply, cfg);
    if (local) {
      return note({
        ...local,
        member,
        messageId,
        escalate: local.confidence < escalateBelow,
        // The record keeps what was looked at, since a typed model gives no reasoning.
        evidence: { rule: local.rule, ratio: local.ratio ?? null, detail: local.detail ?? null },
      });
    }

    if (!jev) {
      return note({
        decision: "UNCLEAR",
        confidence: 0,
        via: "local",
        rule: "inconclusive_no_client",
        needsJev: true,
        escalate: true,
        member,
        messageId,
        evidence: { ratio: overlapRatio(received, reply) },
      });
    }

    if (stats.jev >= maxJevCalls) {
      return note({
        decision: "UNCLEAR",
        confidence: 0,
        via: "local",
        rule: "jev_budget",
        needsJev: true,
        escalate: true,
        member,
        messageId,
        evidence: { ratio: overlapRatio(received, reply), max_jev_calls: maxJevCalls },
      });
    }

    const state = { material: String(received), reply: String(reply) };
    const questions = buildQuestions();
    let res;
    try {
      res = await jev.evaluate({ model, state, questions });
    } catch (e) {
      // A failing client must never take the dispatcher down or pass as a verdict.
      return note({
        decision: "UNCLEAR",
        confidence: 0,
        via: "jev",
        rule: "typed_error",
        model,
        member,
        messageId,
        escalate: true,
        evidence: { error: String(e && e.message || e), state, questions },
      });
    }

    const choice = res?.responsive || {};
    const rawConfidence = choice.confidence;
    const wellFormed =
      VERDICTS.includes(choice.choice)
      && typeof rawConfidence === "number"
      && Number.isFinite(rawConfidence)
      && rawConfidence >= 0
      && rawConfidence <= 1;
    // Off-schema choice or a confidence that is not a number in [0, 1]: a NaN
    // would compare false against escalateBelow and sail through un-escalated.
    const decision = wellFormed ? choice.choice : "UNCLEAR";
    const confidence = wellFormed ? rawConfidence : 0;

    return note({
      decision,
      confidence,
      via: "jev",
      rule: wellFormed ? "typed" : "typed_invalid",
      model: res?.model || model,
      member,
      messageId,
      escalate: !wellFormed || confidence < escalateBelow,
      // No chain of thought exists, so persist the inputs and the raw numbers instead.
      evidence: {
        probabilities: choice.probabilities ?? null,
        cites_specifics: res?.cites_specifics?.probability ?? null,
        claims_nothing_received: res?.claims_nothing_received?.probability ?? null,
        state,
        questions,
      },
    });
  }

  return { judge, stats: () => ({ ...stats, byRule: { ...stats.byRule } }) };
}
