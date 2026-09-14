// src/store.mjs — SQLite store with transactional hash-chained Record.
// Node 26, node:sqlite DatabaseSync only. Zero npm deps.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { councilHome, ensureHome } from "./home.mjs";

const GENESIS = "0".repeat(64);
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

function sha256(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}

/** Canonical JSON: sorted object keys, stable arrays, no whitespace. */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

export function eventHash(row, prevHash) {
  const body = {
    seq: row.seq,
    ts: row.ts,
    kind: row.kind,
    actor: row.actor,
    ref_table: row.ref_table ?? null,
    ref_id: row.ref_id ?? null,
    payload: row.payload ?? null,
  };
  return sha256(canonical(body) + String(prevHash ?? GENESIS));
}

function nowIso() {
  return new Date().toISOString();
}

export function openStore(opts = {}) {
  const home = ensureHome(opts.home || councilHome());
  const dbPath = opts.dbPath || join(home, "council.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec("PRAGMA busy_timeout=5000;");

  // Schema migrations table
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied TEXT NOT NULL
  )`);

  const applied = new Set(
    db.prepare("SELECT name FROM schema_migrations").all().map((r) => r.name)
  );
  const files = existsSync(MIGRATIONS_DIR)
    ? readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()
    : [];
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations(name, applied) VALUES(?, ?)").run(name, nowIso());
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  }

  function prepare(sql) {
    return db.prepare(sql);
  }

  function exec(sql) {
    return db.exec(sql);
  }

  /** Run fn inside BEGIN IMMEDIATE … COMMIT; roll back on throw. */
  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn({ db, prepare, exec });
      db.exec("COMMIT");
      return result;
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  }

  /**
   * Every write path: inside one transaction, run fn(api), then append an events
   * row with hash = sha256(canonical(row) + prev_hash).
   * fn receives { db, prepare, exec, appendExtraEvent, setRef }.
   * Return value of fn becomes commit().result; event metadata may be set via setRef.
   */
  function commit(kind, actor, fn) {
    return tx(({ db: d, prepare: p, exec: e }) => {
      let ref_table = null;
      let ref_id = null;
      let payload = null;
      const extras = [];

      const api = {
        db: d,
        prepare: p,
        exec: e,
        nowIso,
        uuid: () => randomUUID(),
        setRef(table, id, pl = null) {
          ref_table = table;
          ref_id = id == null ? null : String(id);
          if (pl !== undefined) payload = pl == null ? null : (typeof pl === "string" ? pl : JSON.stringify(pl));
        },
        appendExtraEvent(extraKind, extraActor, extra = {}) {
          extras.push({
            kind: extraKind,
            actor: extraActor || actor,
            ref_table: extra.ref_table ?? null,
            ref_id: extra.ref_id == null ? null : String(extra.ref_id),
            payload: extra.payload == null ? null : (typeof extra.payload === "string" ? extra.payload : JSON.stringify(extra.payload)),
          });
        },
      };

      const result = fn(api);

      const insertEvent = (evKind, evActor, meta) => {
        const prev = p("SELECT hash FROM events ORDER BY seq DESC LIMIT 1").get();
        const prev_hash = prev?.hash || GENESIS;
        const ts = nowIso();
        // Insert with placeholder hash, then update with real hash that includes seq
        const info = p(
          `INSERT INTO events(ts, kind, actor, ref_table, ref_id, payload, hash, prev_hash)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          ts,
          evKind,
          evActor,
          meta.ref_table,
          meta.ref_id,
          meta.payload,
          "pending",
          prev_hash
        );
        const seq = Number(info.lastInsertRowid);
        const hash = eventHash(
          {
            seq,
            ts,
            kind: evKind,
            actor: evActor,
            ref_table: meta.ref_table,
            ref_id: meta.ref_id,
            payload: meta.payload,
          },
          prev_hash
        );
        p("UPDATE events SET hash = ? WHERE seq = ?").run(hash, seq);
        return { seq, hash, prev_hash, ts };
      };

      const main = insertEvent(kind, actor, { ref_table, ref_id, payload });
      const extraRows = extras.map((ex) =>
        insertEvent(ex.kind, ex.actor, {
          ref_table: ex.ref_table,
          ref_id: ex.ref_id,
          payload: ex.payload,
        })
      );

      return { result, event: main, extras: extraRows };
    });
  }

  function verifyChain() {
    const rows = prepare("SELECT * FROM events ORDER BY seq ASC").all();
    let prev = GENESIS;
    for (const row of rows) {
      const expected = eventHash(row, prev);
      if (row.hash !== expected) {
        return { ok: false, at: row.seq, expected, got: row.hash };
      }
      if (row.prev_hash !== prev) {
        return { ok: false, at: row.seq, reason: "prev_hash mismatch", expected: prev, got: row.prev_hash };
      }
      prev = row.hash;
    }
    return { ok: true, count: rows.length };
  }

  function getEvents() {
    return prepare("SELECT * FROM events ORDER BY seq ASC").all();
  }

  function close() {
    db.close();
  }

  return {
    home,
    dbPath,
    db,
    prepare,
    exec,
    tx,
    commit,
    verifyChain,
    getEvents,
    close,
    nowIso,
  };
}

export { GENESIS, sha256 };