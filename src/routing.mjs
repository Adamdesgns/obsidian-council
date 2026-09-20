// src/routing.mjs — the single owner-say routing contract.
//
// Both entry points (POST /owner/say in api.mjs and dispatcher.ownerSay) route
// through here so there is exactly one parser and one root rule:
//
//   - @mentions of known members in the content form the hop chain.
//   - When a chain exists, the root message is delivered ONLY to the first
//     member; the full chain and hop=0 are persisted on the root row in the
//     same commit (the dispatcher advances hops as replies complete).
//   - Repeated mentions are legitimate hops (@codex ... @codex).
//   - Unknown @names are plain text, never routes.
//   - "@owner" is plain text too. The owner is the floor: nobody dispatches
//     for it, and every chain already ends with the last member replying to
//     the owner. Putting "owner" in the chain made "@owner and @codex ..."
//     deliver the root to a seat with no runner (HTTP 200, zero runs) and made
//     "@codex ... @owner ... @grok" relay into the void before grok ran.
//   - No chain + explicit recipients -> those recipients, verbatim.
//   - No chain + no recipients -> defaultBroadcast(): the seats whose role is
//     deliberator (codex+fable today). Executors (grok) and the arbiter
//     (claude) only speak when addressed, so their quotas are not spent on
//     unaddressed lines. fable shares claude's anthropic ceiling (spawn.mjs).
//   - The routable set is the seat table (seats.mjs), so a new seat such as
//     @fable is routable without touching this file.
import { seatIds, allSeats } from "./seats.mjs";

/**
 * Unaddressed owner messages go to the deliberators, never the executors.
 * council.mjs runs a dispatcher seat for every seat, so nothing returned here
 * can be a dead letter.
 */
export function defaultBroadcast() {
  return allSeats().filter((s) => s.role === "deliberator").map((s) => s.id);
}

export function parseAddressChain(text) {
  const found = [];
  // "owner" is deliberately NOT routable. outbox.claim is recipient-scoped and
  // the dispatcher only loops real members, so a delivery addressed to "owner"
  // can never be claimed — it becomes a dead letter with no event recorded.
  // The final reply already returns to the owner via the dispatcher's
  // `["owner"]` fallback; the owner never needs to be a hop. seats.mjs has no
  // owner entry, so the seat table is the whole routable set.
  const known = new Set(seatIds());
  const re = /@([a-zA-Z][\w-]*)/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const id = m[1].toLowerCase();
    if (known.has(id)) found.push(id);
  }
  return found;
}

/** Route an owner utterance through the outbox under the shared contract. */
export function routeOwnerSay(outbox, envelope = {}) {
  const chain = parseAddressChain(envelope.content || "");
  const supplied = Array.isArray(envelope.recipients)
    ? envelope.recipients.map((r) => String(r)).filter(Boolean)
    : envelope.recipient
      ? [String(envelope.recipient)]
      : [];
  const recipients = chain.length
    ? [chain[0]]
    : supplied.length
      ? supplied
      : defaultBroadcast();
  return outbox.send({
    ...envelope,
    sender: "owner",
    recipients,
    kind: envelope.kind || "say",
    idempotency_key:
      envelope.idempotency_key || `owner-say:${Date.now()}:${crypto.randomUUID()}`,
    chain: chain.length ? chain : undefined,
    chain_hop: chain.length ? 0 : undefined,
  });
}
