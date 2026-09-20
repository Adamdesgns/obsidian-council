// src/verdict.mjs — read a deliberator's closing verdict line.
//
// Deliberately strict and deliberately pessimistic: anything we cannot read as
// explicit agreement counts as disagreement. A model that cannot follow the
// format has not demonstrated agreement, and a false "AGREE" is the one failure
// this whole engine exists to prevent.
//
// The protocol is one line, at the start of a line, upper-case, followed by a
// colon. The LAST well-formed line wins. No markdown, no prose prefix.
//
//   AGREE: <the answer both now hold>        body required
//   DISAGREE: <what is still wrong>          body optional
//   ESCALATE: <why this needs the owner now> body optional

export const VERDICT_KINDS = ["AGREE", "DISAGREE", "ESCALATE"];

const VERDICT_RE = /^[ \t]*(AGREE|DISAGREE|ESCALATE)[ \t]*:[ \t]*(.*)$/gm;

/**
 * @returns {{kind: "AGREE"|"DISAGREE"|"ESCALATE", body: string, malformed: boolean, line?: string}}
 */
export function parseVerdict(text) {
  const s = String(text ?? "");
  let last = null;
  for (const m of s.matchAll(VERDICT_RE)) {
    const kind = m[1];
    const body = m[2].trim();
    // An AGREE that states no answer has agreed to nothing; keep looking for a
    // later clean line rather than accepting it.
    if (kind === "AGREE" && !body) continue;
    last = { kind, body, malformed: false, line: m[0].trim() };
  }
  if (!last) return { kind: "DISAGREE", body: "", malformed: true };
  return last;
}
