// test/deliberation.test.mjs — Deliberation Engine Task 6: the deliberations table.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../src/store.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIGRATION = join(ROOT, "src", "migrations", "003_deliberations.sql");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "council-delib-"));
}

function withStore(fn) {
  const home = tempHome();
  process.env.COUNCIL_HOME = home;
  const store = openStore({ home });
  try {
    return fn(store, home);
  } finally {
    try { store.close(); } catch { /* */ }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
  }
}

describe("deliberations schema", () => {
  it("creates the table on open", () => withStore((store) => {
    const row = store.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='deliberations'"
    ).get();
    assert.equal(row?.name, "deliberations");
  }));

  it("has exactly the columns the spec names, with the right nullability and defaults", () => withStore((store) => {
    const cols = store.prepare("PRAGMA table_info(deliberations)").all();
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    assert.deepEqual(
      cols.map((c) => c.name),
      ["id", "chamber_id", "question", "category", "state", "round", "flag", "deliberators", "answers", "final_answer", "content_hash", "stall_detail", "created", "updated"]
    );
    assert.equal(byName.id.pk, 1);
    for (const required of ["question", "state", "round", "deliberators", "answers", "created", "updated"]) {
      assert.equal(byName[required].notnull, 1, `${required} must be NOT NULL`);
    }
    for (const optional of ["chamber_id", "category", "flag", "final_answer", "content_hash", "stall_detail"]) {
      assert.equal(byName[optional].notnull, 0, `${optional} must be nullable`);
    }
    assert.equal(byName.round.dflt_value, "0");
    assert.equal(byName.answers.dflt_value, "'{}'");
  }));

  it("indexes state and chamber_id", () => withStore((store) => {
    const idx = store.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='deliberations' AND name LIKE 'idx_%' ORDER BY name"
    ).all().map((r) => r.name);
    assert.deepEqual(idx, ["idx_delib_chamber", "idx_delib_state"]);
  }));

  it("is recorded in schema_migrations and re-opening the same home does not re-run or fail", () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    let store = openStore({ home });
    try {
      const applied = () => store.prepare("SELECT name FROM schema_migrations ORDER BY name").all().map((r) => r.name);
      assert.deepEqual(applied(), ["001_init.sql", "002_messages_chain.sql", "003_deliberations.sql"]);
      store.prepare(
        `INSERT INTO deliberations(id, question, state, deliberators, created, updated) VALUES(?,?,?,?,?,?)`
      ).run("d1", "q", "answer_1", '["codex","fable"]', "t", "t");
      store.close();
      store = openStore({ home });
      assert.deepEqual(applied(), ["001_init.sql", "002_messages_chain.sql", "003_deliberations.sql"]);
      assert.equal(store.prepare("SELECT COUNT(*) AS c FROM deliberations").get().c, 1, "data survives re-open");
    } finally {
      try { store.close(); } catch { /* */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("the migration file carries no BEGIN/COMMIT: the runner wraps it", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    assert.doesNotMatch(sql, /\b(BEGIN|COMMIT|ROLLBACK)\b/i);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS deliberations/);
  });

  it("deliberators and answers are JSON strings that round-trip through the row; answers defaults to {}", () => withStore((store) => {
    const deliberators = ["codex", "fable"];
    const answers = { codex: "m-1", fable: "m-2" };
    store.commit("deliberation_opened", "owner", (api) => {
      api.prepare(
        `INSERT INTO deliberations(id, chamber_id, question, state, deliberators, answers, created, updated)
         VALUES(?,?,?,?,?,?,?,?)`
      ).run("d1", "c1", "Should we?", "answer_1", JSON.stringify(deliberators), JSON.stringify(answers), api.nowIso(), api.nowIso());
      api.prepare(
        `INSERT INTO deliberations(id, question, state, deliberators, created, updated) VALUES(?,?,?,?,?,?)`
      ).run("d2", "Bare row", "answer_1", JSON.stringify(deliberators), api.nowIso(), api.nowIso());
      api.setRef("deliberations", "d1", { deliberators });
    });
    const d1 = store.prepare("SELECT * FROM deliberations WHERE id = 'd1'").get();
    assert.deepEqual(JSON.parse(d1.deliberators), deliberators);
    assert.deepEqual(JSON.parse(d1.answers), answers);
    assert.equal(d1.round, 0);
    assert.equal(d1.flag, null);
    const d2 = store.prepare("SELECT answers, round FROM deliberations WHERE id = 'd2'").get();
    assert.deepEqual(JSON.parse(d2.answers), {});
    assert.equal(d2.round, 0);
    assert.equal(store.verifyChain().ok, true);
  }));

  it("NOT NULL columns are enforced", () => withStore((store) => {
    assert.throws(
      () => store.prepare(`INSERT INTO deliberations(id, state, deliberators, created, updated) VALUES('d3','answer_1','[]','t','t')`).run(),
      /NOT NULL constraint failed: deliberations\.question/
    );
  }));
});
