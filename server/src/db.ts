import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type Db = Database.Database;

export function openDb(databasePath: string): Db {
  const dir = path.dirname(databasePath);
  if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS machines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      interval_sec INTEGER NOT NULL DEFAULT 5,
      agent_key_hash TEXT NOT NULL,
      agent_key_enc TEXT NOT NULL DEFAULT '',
      agent_ws_url TEXT NOT NULL DEFAULT '',
      expires_at INTEGER,
      purchase_amount_cents INTEGER NOT NULL DEFAULT 0,
      billing_cycle TEXT NOT NULL DEFAULT 'month',
      auto_renew INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      online INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id INTEGER NOT NULL,
      at INTEGER NOT NULL,
      cpu_usage REAL NOT NULL,
      mem_used INTEGER NOT NULL,
      mem_total INTEGER NOT NULL,
      disk_used INTEGER NOT NULL,
      disk_total INTEGER NOT NULL,
      net_rx_bytes INTEGER NOT NULL DEFAULT 0,
      net_tx_bytes INTEGER NOT NULL DEFAULT 0,
      load_1 REAL NOT NULL DEFAULT 0,
      load_5 REAL NOT NULL DEFAULT 0,
      load_15 REAL NOT NULL DEFAULT 0,
      FOREIGN KEY(machine_id) REFERENCES machines(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_machine_at ON metrics(machine_id, at DESC);
  `);

  ensureColumns(db, "machines", [
    { name: "sort_order", sql: "ALTER TABLE machines ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0" },
    { name: "agent_key_enc", sql: "ALTER TABLE machines ADD COLUMN agent_key_enc TEXT NOT NULL DEFAULT ''" },
    { name: "agent_ws_url", sql: "ALTER TABLE machines ADD COLUMN agent_ws_url TEXT NOT NULL DEFAULT ''" },
    { name: "expires_at", sql: "ALTER TABLE machines ADD COLUMN expires_at INTEGER" },
    {
      name: "purchase_amount_cents",
      sql: "ALTER TABLE machines ADD COLUMN purchase_amount_cents INTEGER NOT NULL DEFAULT 0",
    },
    { name: "billing_cycle", sql: "ALTER TABLE machines ADD COLUMN billing_cycle TEXT NOT NULL DEFAULT 'month'" },
    { name: "auto_renew", sql: "ALTER TABLE machines ADD COLUMN auto_renew INTEGER NOT NULL DEFAULT 0" },
  ]);

  ensureColumns(db, "metrics", [
    { name: "net_rx_bytes", sql: "ALTER TABLE metrics ADD COLUMN net_rx_bytes INTEGER NOT NULL DEFAULT 0" },
    { name: "net_tx_bytes", sql: "ALTER TABLE metrics ADD COLUMN net_tx_bytes INTEGER NOT NULL DEFAULT 0" },
    { name: "load_1", sql: "ALTER TABLE metrics ADD COLUMN load_1 REAL NOT NULL DEFAULT 0" },
    { name: "load_5", sql: "ALTER TABLE metrics ADD COLUMN load_5 REAL NOT NULL DEFAULT 0" },
    { name: "load_15", sql: "ALTER TABLE metrics ADD COLUMN load_15 REAL NOT NULL DEFAULT 0" },
  ]);

  // Best-effort backfill for existing rows
  try {
    db.exec("UPDATE machines SET sort_order = id WHERE sort_order = 0");
  } catch {
    // ignore
  }
}

function ensureColumns(db: Db, table: string, cols: Array<{ name: string; sql: string }>) {
  const existing = new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((r: any) => String(r.name))
  );
  for (const c of cols) {
    if (existing.has(c.name)) continue;
    db.exec(c.sql);
  }
}
