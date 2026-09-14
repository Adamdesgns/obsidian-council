// src/sanctions.mjs — Black Seat gate (G3)
import { createHash } from "node:crypto";

export function contentHash(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/**
 * Approve only if: owner decided, status approved, hash matches, not expired, not revoked, not used (or allow once).
 */
export function assertSanction(store, { content, content_hash, sanction_id, actor }) {
  if (actor && actor !== "owner") {
    return { ok: false, reason: "member_cannot_approve" };
  }
  const row = sanction_id
    ? store.prepare("SELECT * FROM sanctions WHERE id = ?").get(sanction_id)
    : store.prepare(
        "SELECT * FROM sanctions WHERE content_hash = ? ORDER BY decided_at DESC LIMIT 1"
      ).get(content_hash || contentHash(content));

  if (!row) return { ok: false, reason: "no_sanction" };
  if (row.status === "revoked") return { ok: false, reason: "revoked" };
  if (row.status === "rejected") return { ok: false, reason: "rejected" };
  if (row.status !== "approved") return { ok: false, reason: "not_approved" };
  if (row.decided_by !== "owner") return { ok: false, reason: "forged_decider" };

  const expected = content_hash || contentHash(content);
  if (row.content_hash !== expected) return { ok: false, reason: "hash_mismatch" };

  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  if (row.used_at) return { ok: false, reason: "already_used" };

  return { ok: true, sanction: row };
}

export function markUsed(store, sanctionId, actor = "system") {
  return store.commit("sanction_used", actor, (api) => {
    api.prepare("UPDATE sanctions SET used_at = ? WHERE id = ?").run(api.nowIso(), sanctionId);
    api.setRef("sanctions", sanctionId, { used: true });
  });
}

export function revoke(store, sanctionId, actor = "owner") {
  if (actor !== "owner") return { ok: false, reason: "member_cannot_approve" };
  return store.commit("sanction_revoked", actor, (api) => {
    api.prepare("UPDATE sanctions SET status = 'revoked' WHERE id = ?").run(sanctionId);
    api.setRef("sanctions", sanctionId, { revoked: true });
    return { ok: true };
  }).result;
}