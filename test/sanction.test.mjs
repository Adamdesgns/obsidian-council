// test/sanction.test.mjs — P2-6 G3 Black Seat
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore } from "../src/store.mjs";
import { contentHash, assertSanction, revoke, markUsed } from "../src/sanctions.mjs";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "council-p2-san-"));
}

function seedApproved(store, text, extra = {}) {
  const hash = contentHash(text);
  const id = extra.id || "san-1";
  store.commit("sanction_decided", "owner", (api) => {
    api.prepare(
      `INSERT INTO sanctions(id, directive_id, content_hash, scopes, decided_by, decided_at, expires_at, used_at, status)
       VALUES(?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      extra.directive_id || null,
      hash,
      "[]",
      extra.decided_by || "owner",
      api.nowIso(),
      extra.expires_at || null,
      null,
      extra.status || "approved"
    );
    api.setRef("sanctions", id, { hash });
  });
  return { id, hash };
}

describe("P2-6 G3 sanctions", () => {
  it("hash-bound approval permits only matching content", () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    try {
      const plan = "plan A exact";
      const { id, hash } = seedApproved(store, plan);
      assert.equal(assertSanction(store, { content: plan, sanction_id: id, actor: "owner" }).ok, true);
      assert.equal(assertSanction(store, { content: "plan B modified", sanction_id: id, actor: "owner" }).ok, false);
      assert.equal(assertSanction(store, { content: "plan B modified", sanction_id: id, actor: "owner" }).reason, "hash_mismatch");
      assert.equal(hash, contentHash(plan));
    } finally {
      store.close();
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("expired, revoked, forged decider, member token all fail closed", () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    try {
      const text = "do the thing";
      seedApproved(store, text, {
        id: "san-exp",
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      });
      assert.equal(assertSanction(store, { content: text, sanction_id: "san-exp", actor: "owner" }).reason, "expired");

      seedApproved(store, text, { id: "san-ok" });
      revoke(store, "san-ok", "owner");
      assert.equal(assertSanction(store, { content: text, sanction_id: "san-ok", actor: "owner" }).reason, "revoked");

      seedApproved(store, text, { id: "san-forge", decided_by: "codex" });
      // decided_by forged in DB
      assert.equal(assertSanction(store, { content: text, sanction_id: "san-forge", actor: "owner" }).reason, "forged_decider");

      seedApproved(store, text, { id: "san-mem" });
      assert.equal(assertSanction(store, { content: text, sanction_id: "san-mem", actor: "codex" }).reason, "member_cannot_approve");
    } finally {
      store.close();
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});