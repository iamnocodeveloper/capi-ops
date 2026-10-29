import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IncidentRow, Severity } from './types.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS servers (
  alias TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  ip TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory (
  alias TEXT NOT NULL,
  app_uuid TEXT NOT NULL,
  name TEXT NOT NULL,
  fqdn TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (alias, app_uuid)
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  last_notified_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_incidents_key ON incidents(key, resolved_at);

CREATE TABLE IF NOT EXISTS metrics (
  alias TEXT NOT NULL,
  ts INTEGER NOT NULL,
  cpu REAL,
  mem_percent REAL,
  disk_percent REAL,
  load1 REAL
);
CREATE INDEX IF NOT EXISTS idx_metrics_alias_ts ON metrics(alias, ts);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  command TEXT NOT NULL,
  args_json TEXT NOT NULL,
  result TEXT NOT NULL,
  ok INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec(SCHEMA);
  }

  // ── settings ───────────────────────────────────────────────
  getSetting(key: string): string | null {
    const row = this.raw.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  setSetting(key: string, value: string): void {
    this.raw
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  getLastWahaNumber(): number {
    const v = this.getSetting('last_waha_number');
    return v ? Number(v) : 0;
  }

  setLastWahaNumber(n: number): void {
    this.setSetting('last_waha_number', String(n));
  }

  // ── inventory ──────────────────────────────────────────────
  replaceInventory(alias: string, apps: Array<{ uuid: string; name: string; fqdn: string }>): void {
    this.raw.prepare('DELETE FROM inventory WHERE alias = ?').run(alias);
    const stmt = this.raw.prepare(
      'INSERT INTO inventory (alias, app_uuid, name, fqdn, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    const now = Date.now();
    for (const app of apps) stmt.run(alias, app.uuid, app.name, app.fqdn, now);
  }

  inventory(): Array<{ alias: string; app_uuid: string; name: string; fqdn: string }> {
    return this.raw
      .prepare('SELECT alias, app_uuid, name, fqdn FROM inventory ORDER BY name')
      .all() as Array<{ alias: string; app_uuid: string; name: string; fqdn: string }>;
  }

  // ── incidents ──────────────────────────────────────────────
  openIncident(key: string): IncidentRow | null {
    const row = this.raw
      .prepare('SELECT * FROM incidents WHERE key = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1')
      .get(key) as IncidentRow | undefined;
    return row ?? null;
  }

  createIncident(key: string, severity: Severity, title: string, detail: string): IncidentRow {
    const now = Date.now();
    const info = this.raw
      .prepare(
        'INSERT INTO incidents (key, severity, title, detail, opened_at, last_notified_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      )
      .run(key, severity, title, detail, now, now);
    const id = Number(info.lastInsertRowid);
    return {
      id,
      key,
      severity,
      title,
      detail,
      opened_at: now,
      last_notified_at: now,
      resolved_at: null,
    };
  }

  touchIncident(id: number, detail: string, severity: Severity): void {
    const now = Date.now();
    this.raw
      .prepare('UPDATE incidents SET last_notified_at = ?, detail = ?, severity = ? WHERE id = ?')
      .run(now, detail, severity, id);
  }

  resolveIncident(key: string): IncidentRow | null {
    const open = this.openIncident(key);
    if (!open) return null;
    this.raw.prepare('UPDATE incidents SET resolved_at = ? WHERE id = ?').run(Date.now(), open.id);
    return open;
  }

  openIncidents(): IncidentRow[] {
    return this.raw
      .prepare('SELECT * FROM incidents WHERE resolved_at IS NULL ORDER BY opened_at DESC')
      .all() as unknown as IncidentRow[];
  }

  // ── metrics ────────────────────────────────────────────────
  addMetric(alias: string, m: { cpu: number | null; memPercent: number | null; diskPercent: number | null; load1: number | null }): void {
    this.raw
      .prepare('INSERT INTO metrics (alias, ts, cpu, mem_percent, disk_percent, load1) VALUES (?, ?, ?, ?, ?, ?)')
      .run(alias, Date.now(), m.cpu, m.memPercent, m.diskPercent, m.load1);
  }

  /** Media y desvío de una métrica en la franja horaria ±3h de los últimos `days` días. */
  baseline(alias: string, column: 'cpu' | 'mem_percent' | 'disk_percent' | 'load1', days = 7): { mean: number; sd: number; n: number } {
    const since = Date.now() - days * 86_400_000;
    const rows = this.raw
      .prepare(`SELECT ts, ${column} AS v FROM metrics WHERE alias = ? AND ts >= ? AND ${column} IS NOT NULL`)
      .all(alias, since) as Array<{ ts: number; v: number }>;
    const hour = new Date().getHours();
    const sameBand = rows.filter((r) => {
      const h = new Date(r.ts).getHours();
      const diff = Math.min(Math.abs(h - hour), 24 - Math.abs(h - hour));
      return diff <= 3;
    });
    const sample = sameBand.length >= 20 ? sameBand : rows;
    if (sample.length < 10) return { mean: 0, sd: 0, n: sample.length };
    const mean = sample.reduce((a, r) => a + r.v, 0) / sample.length;
    const variance = sample.reduce((a, r) => a + (r.v - mean) ** 2, 0) / sample.length;
    return { mean, sd: Math.sqrt(variance), n: sample.length };
  }

  pruneMetrics(days = 30): void {
    this.raw.prepare('DELETE FROM metrics WHERE ts < ?').run(Date.now() - days * 86_400_000);
  }

  // ── audit ──────────────────────────────────────────────────
  addAction(a: {
    chatId: number;
    userId: number;
    command: string;
    args: unknown;
    result: string;
    ok: boolean;
    durationMs: number;
  }): void {
    this.raw
      .prepare(
        'INSERT INTO actions (ts, chat_id, user_id, command, args_json, result, ok, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        Date.now(),
        a.chatId,
        a.userId,
        a.command,
        JSON.stringify(a.args),
        a.result.slice(0, 4000),
        a.ok ? 1 : 0,
        a.durationMs,
      );
  }

  recentActions(limit = 10): Array<{
    ts: number;
    chat_id: number;
    user_id: number;
    command: string;
    result: string;
    ok: number;
  }> {
    return this.raw
      .prepare('SELECT ts, chat_id, user_id, command, result, ok FROM actions ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{
      ts: number;
      chat_id: number;
      user_id: number;
      command: string;
      result: string;
      ok: number;
    }>;
  }
}
