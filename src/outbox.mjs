// src/outbox.mjs — durable message outbox with leases and idempotency.
import { openStore } from "./store.mjs";

const DEFAULT_LEASE_MS = 60_000;

export function createOutbox(storeOrOpts = {}, opts = {}) {
  const owns = typeof storeOrOpts.commit !== "function";
  const store = owns ? openStore(storeOrOpts) : storeOrOpts;
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;

  function send(envelope, transactionApi = null) {
    if (!envelope || typeof envelope !== "object") throw new Error("envelope required");
    const key = envelope.idempotency_key;
    if (!key) throw new Error("idempotency_key required");
    if (envelope.sender === "engine" || /^(?:delib(?:eration)?|work)[:\-]/.test(String(key))) {
      throw Object.assign(new Error("engine_envelope_reserved"), { statusCode: 400 });
    }

    const recipients = normalizeRecipients(envelope);
    if (!recipients.length) throw new Error("at least one recipient required");

    const existing = store.prepare(
      "SELECT * FROM messages WHERE idempotency_key = ?"
    ).get(key);
    if (existing) {
      return {
        message: rowToMessage(existing),
        deliveries: store.prepare("SELECT * FROM deliveries WHERE message_id = ?").all(existing.id),
        duplicate: true,
      };
    }

    try {
      const write = (api) => {
        const again = api.prepare(
          "SELECT * FROM messages WHERE idempotency_key = ?"
        ).get(key);
        if (again) {
          api.setRef("messages", again.id, { duplicate: true });
          return {
            message: rowToMessage(again),
            deliveries: api.prepare("SELECT * FROM deliveries WHERE message_id = ?").all(again.id),
            duplicate: true,
          };
        }

        const id = envelope.id || api.uuid();
        const created = api.nowIso();
        const chainJson = envelope.chain == null
          ? null
          : (typeof envelope.chain === "string" ? envelope.chain : JSON.stringify(envelope.chain));
        const chainHop = envelope.chain_hop == null ? null : Number(envelope.chain_hop);
        api.prepare(
          `INSERT INTO messages(id, chamber_id, sender, recipients, kind, parent_id, content, idempotency_key, created, chain, chain_hop)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          id,
          envelope.chamber_id ?? null,
          envelope.sender || "unknown",
          JSON.stringify(recipients),
          envelope.kind || envelope.type || "message",
          envelope.parent_id ?? null,
          typeof envelope.content === "string" ? envelope.content : JSON.stringify(envelope.content ?? ""),
          key,
          created,
          chainJson,
          chainHop
        );

        // P2-6f: advance root hop in the same commit as the next delivery
        if (envelope.advance_chain && envelope.advance_chain.root_id != null) {
          const rootId = envelope.advance_chain.root_id;
          const nextHop = Number(envelope.advance_chain.hop);
          api.prepare(`UPDATE messages SET chain_hop = ? WHERE id = ?`).run(nextHop, rootId);
        }

        const deliveries = [];
        for (const recipient of recipients) {
          const info = api.prepare(
            `INSERT INTO deliveries(message_id, recipient, status, attempt_gen, lease_until, updated)
             VALUES(?,?, 'pending', 0, NULL, ?)`
          ).run(id, recipient, created);
          deliveries.push({
            id: Number(info.lastInsertRowid),
            message_id: id,
            recipient,
            status: "pending",
            attempt_gen: 0,
            lease_until: null,
            updated: created,
          });
        }

        api.setRef("messages", id, { recipients, kind: envelope.kind || envelope.type || "message" });
        return {
          message: {
            id,
            chamber_id: envelope.chamber_id ?? null,
            sender: envelope.sender || "unknown",
            recipients,
            kind: envelope.kind || envelope.type || "message",
            parent_id: envelope.parent_id ?? null,
            content: typeof envelope.content === "string" ? envelope.content : JSON.stringify(envelope.content ?? ""),
            idempotency_key: key,
            created,
            chain: chainJson,
            chain_hop: chainHop,
          },
          deliveries,
          duplicate: false,
        };
      };
      // respond() shares this write with its acknowledgement transaction.
      const committed = transactionApi
        ? { result: write(transactionApi) }
        : store.commit("message_sent", envelope.sender || "unknown", write);
      return committed.result;
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String(e.message || e))) {
        const row = store.prepare("SELECT * FROM messages WHERE idempotency_key = ?").get(key);
        if (row) {
          return {
            message: rowToMessage(row),
            deliveries: store.prepare("SELECT * FROM deliveries WHERE message_id = ?").all(row.id),
            duplicate: true,
          };
        }
      }
      throw e;
    }
  }

  function claim(recipient, claimOpts = {}) {
    if (!recipient) throw new Error("recipient required");
    const ms = claimOpts.leaseMs ?? leaseMs;

    const committed = store.commit("delivery_claimed", recipient, (api) => {
      const nowIso = api.nowIso();
      const row = api.prepare(
        `SELECT * FROM deliveries
         WHERE recipient = ? AND (? IS NULL OR id = ?)
           AND (? IS NOT NULL OR (
             NOT EXISTS (SELECT 1 FROM deliberation_messages dm WHERE dm.message_id=deliveries.message_id)
             AND NOT EXISTS (SELECT 1 FROM work_order_messages wm WHERE wm.message_id=deliveries.message_id)
           ))
           AND (
             status = 'pending'
             OR (status = 'leased' AND lease_until IS NOT NULL AND lease_until < ?)
           )
         ORDER BY id ASC
         LIMIT 1`
      ).get(recipient, claimOpts.deliveryId ?? null, claimOpts.deliveryId ?? null, claimOpts.deliveryId ?? null, nowIso);

      if (!row) {
        api.setRef("deliveries", null, { recipient, empty: true });
        return null;
      }

      const gen = (row.attempt_gen || 0) + 1;
      const leaseUntil = new Date(Date.now() + ms).toISOString();
      const info = api.prepare(
        `UPDATE deliveries
         SET status = 'leased', attempt_gen = ?, lease_until = ?, updated = ?
         WHERE id = ? AND attempt_gen = ?`
      ).run(gen, leaseUntil, nowIso, row.id, row.attempt_gen);

      if (!info.changes) {
        api.setRef("deliveries", row.id, { lost_race: true });
        return null;
      }

      const updated = api.prepare("SELECT * FROM deliveries WHERE id = ?").get(row.id);
      const message = api.prepare("SELECT * FROM messages WHERE id = ?").get(row.message_id);
      api.setRef("deliveries", updated.id, { recipient, gen, message_id: row.message_id });
      return { delivery: updated, message: rowToMessage(message), gen };
    });

    return committed.result;
  }

  function ack(delivery, gen, result = {}) {
    const id = typeof delivery === "object" ? delivery.id : delivery;
    if (id == null) throw new Error("delivery id required");
    const actor = result.actor || "system";
    const status = result.status || "acked";

    // Peek generation to choose event kind (stale vs acked)
    const peek = store.prepare("SELECT * FROM deliveries WHERE id = ?").get(id);
    if (!peek) throw new Error("delivery not found: " + id);
    const stale = Number(gen) !== Number(peek.attempt_gen);
    const kind = stale ? "stale_result_refused" : "delivery_acked";

    const committed = store.commit(kind, actor, (api) => {
      const row = api.prepare("SELECT * FROM deliveries WHERE id = ?").get(id);
      if (!row) throw new Error("delivery not found: " + id);

      if (Number(gen) !== Number(row.attempt_gen)) {
        api.setRef("deliveries", id, {
          stale: true,
          expected_gen: row.attempt_gen,
          got_gen: gen,
          message_id: row.message_id,
        });
        return { ok: false, reason: "stale_generation", expected_gen: row.attempt_gen, got_gen: gen };
      }

      const nowIso = api.nowIso();
      api.prepare(
        `UPDATE deliveries SET status = ?, lease_until = NULL, updated = ? WHERE id = ? AND attempt_gen = ?`
      ).run(status, nowIso, id, gen);
      api.setRef("deliveries", id, { status, gen, message_id: row.message_id });
      return { ok: true, delivery: api.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) };
    });

    return committed.result;
  }

  /** Save a member reply and acknowledge its leased delivery atomically. */
  function respond(deliveryId, gen, result = {}, envelope = null) {
    const actor = result.actor || "system";
    const status = result.status || "acked";
    const envelopes = envelope == null ? [] : Array.isArray(envelope) ? envelope : [envelope];
    const sentShape = (items) => envelope == null ? {} : { sent: Array.isArray(envelope) ? items : items[0] };
    const refused = (reason, details = {}) => ({ ok: false, reason, ack: { ok: false, reason, ...details } });
    if (!["acked", "answered", "waiting"].includes(status)) throw new Error("invalid_response_status");
    return store.commit("delivery_responded", actor, (api) => {
      const row = api.prepare("SELECT * FROM deliveries WHERE id=?").get(deliveryId);
      if (!row || row.recipient !== actor) {
        api.setRef("deliveries", deliveryId, { refused: "delivery_not_owned" });
        return refused("delivery_not_owned");
      }
      if (!Number.isSafeInteger(Number(gen)) || Number(gen) < 1 || Number(gen) !== row.attempt_gen) {
        api.setRef("deliveries", deliveryId, { refused: "stale_generation", expected_gen: row.attempt_gen, got_gen: gen });
        return refused("stale_generation", { expected_gen: row.attempt_gen, got_gen: gen });
      }
      if (["acked", "answered", "waiting"].includes(row.status)) {
        const saved = envelopes.map((item) => api.prepare("SELECT * FROM messages WHERE idempotency_key=?").get(item.idempotency_key)).filter(Boolean);
        api.setRef("deliveries", deliveryId, { duplicate: true, gen });
        return {
          ok: true,
          ack: { ok: true, duplicate: true, delivery: row },
          ...sentShape(saved.map((item) => ({ message: rowToMessage(item), deliveries: api.prepare("SELECT * FROM deliveries WHERE message_id=?").all(item.id), duplicate: true }))),
        };
      }
      if (row.status !== "leased") {
        api.setRef("deliveries", deliveryId, { refused: "delivery_not_leased", status: row.status });
        return refused("delivery_not_leased");
      }
      const sent = envelopes.map((item) => send(item, api));
      api.prepare("UPDATE deliveries SET status=?,lease_until=NULL,updated=? WHERE id=? AND attempt_gen=?")
        .run(status, api.nowIso(), deliveryId, row.attempt_gen);
      api.setRef("deliveries", deliveryId, { status, gen, message_id: row.message_id, reply_ids: sent.map((item) => item.message.id) });
      return {
        ok: true,
        ack: { ok: true, delivery: api.prepare("SELECT * FROM deliveries WHERE id=?").get(deliveryId) },
        ...sentShape(sent),
      };
    }).result;
  }

  function close() {
    if (owns) store.close();
  }

  return { send, claim, ack, respond, store, close, leaseMs };
}

function normalizeRecipients(envelope) {
  if (Array.isArray(envelope.recipients)) return [...new Set(envelope.recipients.map(String))];
  if (envelope.recipient) return [String(envelope.recipient)];
  return [];
}

function rowToMessage(row) {
  if (!row) return null;
  let recipients = row.recipients;
  try {
    recipients = typeof recipients === "string" ? JSON.parse(recipients) : recipients;
  } catch {
    recipients = [recipients];
  }
  let chain = row.chain ?? null;
  if (typeof chain === "string" && chain) {
    try { chain = JSON.parse(chain); } catch { /* keep string */ }
  }
  return {
    id: row.id,
    chamber_id: row.chamber_id,
    sender: row.sender,
    recipients,
    kind: row.kind,
    parent_id: row.parent_id,
    content: row.content,
    idempotency_key: row.idempotency_key,
    created: row.created,
    chain,
    chain_hop: row.chain_hop == null ? null : Number(row.chain_hop),
  };
}

export { DEFAULT_LEASE_MS };
