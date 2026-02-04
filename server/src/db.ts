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

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS machines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      group_name TEXT NOT NULL DEFAULT '',
      hostname TEXT NOT NULL DEFAULT '',
      os_name TEXT NOT NULL DEFAULT '',
      os_version TEXT NOT NULL DEFAULT '',
      arch TEXT NOT NULL DEFAULT '',
      kernel_version TEXT NOT NULL DEFAULT '',
      cpu_model TEXT NOT NULL DEFAULT '',
      cpu_cores INTEGER NOT NULL DEFAULT 0,
      interval_sec INTEGER NOT NULL DEFAULT 5,
      agent_key_hash TEXT NOT NULL,
      agent_key_enc TEXT NOT NULL DEFAULT '',
      agent_ws_url TEXT NOT NULL DEFAULT '',
      expires_at INTEGER,
      purchase_amount_cents INTEGER NOT NULL DEFAULT 0,
      billing_cycle TEXT NOT NULL DEFAULT 'month',
      billing_anchor_day INTEGER NOT NULL DEFAULT 0,
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
      tcp_conn INTEGER NOT NULL DEFAULT 0,
      udp_conn INTEGER NOT NULL DEFAULT 0,
      load_1 REAL NOT NULL DEFAULT 0,
      load_5 REAL NOT NULL DEFAULT 0,
      load_15 REAL NOT NULL DEFAULT 0,
      FOREIGN KEY(machine_id) REFERENCES machines(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_machine_at ON metrics(machine_id, at DESC);

    CREATE TABLE IF NOT EXISTS traffic_monthly (
      machine_id INTEGER NOT NULL,
      month TEXT NOT NULL,
      rx_bytes INTEGER NOT NULL DEFAULT 0,
      tx_bytes INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(machine_id, month),
      FOREIGN KEY(machine_id) REFERENCES machines(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_traffic_monthly_month ON traffic_monthly(month);

    CREATE TABLE IF NOT EXISTS traffic_monthly_state (
      machine_id INTEGER PRIMARY KEY,
      month TEXT NOT NULL,
      last_at INTEGER NOT NULL DEFAULT 0,
      last_rx_bytes INTEGER NOT NULL DEFAULT 0,
      last_tx_bytes INTEGER NOT NULL DEFAULT 0,
      usage_rx_bytes INTEGER NOT NULL DEFAULT 0,
      usage_tx_bytes INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(machine_id) REFERENCES machines(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS traffic_cycles (
      machine_id INTEGER NOT NULL,
      period_key TEXT NOT NULL,
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      rx_bytes INTEGER NOT NULL DEFAULT 0,
      tx_bytes INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(machine_id, period_key),
      FOREIGN KEY(machine_id) REFERENCES machines(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_traffic_cycles_machine_time ON traffic_cycles(machine_id, start_at, end_at);

    CREATE TABLE IF NOT EXISTS traffic_cycles_state (
      machine_id INTEGER PRIMARY KEY,
      anchor_day INTEGER NOT NULL DEFAULT 1,
      period_key TEXT NOT NULL,
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL DEFAULT 0,
      last_rx_bytes INTEGER NOT NULL DEFAULT 0,
      last_tx_bytes INTEGER NOT NULL DEFAULT 0,
      usage_rx_bytes INTEGER NOT NULL DEFAULT 0,
      usage_tx_bytes INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(machine_id) REFERENCES machines(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS machine_notifications (
      machine_id INTEGER PRIMARY KEY,
      last_online INTEGER NOT NULL DEFAULT 0,
      offline_notified_at INTEGER NOT NULL DEFAULT 0,
      online_notified_at INTEGER NOT NULL DEFAULT 0,
      expiry_warn_date TEXT NOT NULL DEFAULT '',
      expired_notified_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(machine_id) REFERENCES machines(id) ON DELETE CASCADE
    );
  `);

  ensureColumns(db, "machines", [
    { name: "sort_order", sql: "ALTER TABLE machines ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0" },
    { name: "group_name", sql: "ALTER TABLE machines ADD COLUMN group_name TEXT NOT NULL DEFAULT ''" },
    { name: "hostname", sql: "ALTER TABLE machines ADD COLUMN hostname TEXT NOT NULL DEFAULT ''" },
    { name: "os_name", sql: "ALTER TABLE machines ADD COLUMN os_name TEXT NOT NULL DEFAULT ''" },
    { name: "os_version", sql: "ALTER TABLE machines ADD COLUMN os_version TEXT NOT NULL DEFAULT ''" },
    { name: "arch", sql: "ALTER TABLE machines ADD COLUMN arch TEXT NOT NULL DEFAULT ''" },
    { name: "kernel_version", sql: "ALTER TABLE machines ADD COLUMN kernel_version TEXT NOT NULL DEFAULT ''" },
    { name: "cpu_model", sql: "ALTER TABLE machines ADD COLUMN cpu_model TEXT NOT NULL DEFAULT ''" },
    { name: "cpu_cores", sql: "ALTER TABLE machines ADD COLUMN cpu_cores INTEGER NOT NULL DEFAULT 0" },
    { name: "agent_key_enc", sql: "ALTER TABLE machines ADD COLUMN agent_key_enc TEXT NOT NULL DEFAULT ''" },
    { name: "agent_ws_url", sql: "ALTER TABLE machines ADD COLUMN agent_ws_url TEXT NOT NULL DEFAULT ''" },
    { name: "expires_at", sql: "ALTER TABLE machines ADD COLUMN expires_at INTEGER" },
    {
      name: "purchase_amount_cents",
      sql: "ALTER TABLE machines ADD COLUMN purchase_amount_cents INTEGER NOT NULL DEFAULT 0",
    },
    { name: "billing_cycle", sql: "ALTER TABLE machines ADD COLUMN billing_cycle TEXT NOT NULL DEFAULT 'month'" },
    { name: "billing_anchor_day", sql: "ALTER TABLE machines ADD COLUMN billing_anchor_day INTEGER NOT NULL DEFAULT 0" },
    { name: "auto_renew", sql: "ALTER TABLE machines ADD COLUMN auto_renew INTEGER NOT NULL DEFAULT 0" },
  ]);

  ensureColumns(db, "metrics", [
    { name: "net_rx_bytes", sql: "ALTER TABLE metrics ADD COLUMN net_rx_bytes INTEGER NOT NULL DEFAULT 0" },
    { name: "net_tx_bytes", sql: "ALTER TABLE metrics ADD COLUMN net_tx_bytes INTEGER NOT NULL DEFAULT 0" },
    { name: "tcp_conn", sql: "ALTER TABLE metrics ADD COLUMN tcp_conn INTEGER NOT NULL DEFAULT 0" },
    { name: "udp_conn", sql: "ALTER TABLE metrics ADD COLUMN udp_conn INTEGER NOT NULL DEFAULT 0" },
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

  // Best-effort backfill billing anchor day:
  // - prefer expires_at day-of-month (UTC)
  // - fallback to created_at day-of-month (UTC)
  try {
    db.exec(`
      UPDATE machines
      SET billing_anchor_day = CASE
        WHEN billing_anchor_day != 0 THEN billing_anchor_day
        WHEN expires_at IS NOT NULL THEN CAST(strftime('%d', expires_at / 1000, 'unixepoch') AS INTEGER)
        ELSE CAST(strftime('%d', created_at / 1000, 'unixepoch') AS INTEGER)
      END
      WHERE billing_anchor_day = 0
    `);
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
