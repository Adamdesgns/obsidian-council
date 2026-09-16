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
//   - No chain + explicit recipients -> those recipients, verbatim.
//   - No chain + no recipients -> DEFAULT_BROADCAST (codex+grok; claude's
//     smaller daily ceiling is only spent when claude is addressed).
export const DEFAULT_BROADCAST = ["codex", "grok"];

const KNOWN = ["codex", "grok", "claude", "owner"];

export function parseAddressChain(text) {
  const found = [];
  const re = /@([a-zA-Z][\w-]*)/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const id = m[1].toLowerCase();
    if (KNOWN.includes(id)) found.push(id);
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
      : [...DEFAULT_BROADCAST];
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
