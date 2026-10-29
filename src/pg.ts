import { Pool } from 'pg';
import type { ServerSnapshot, Severity, WahaHealth } from './types.js';

const CONNECTION = process.env.DATABASE_URL?.trim();

/** Pool de Postgres para el histórico. Si no hay DATABASE_URL, todo queda en no-op. */
export const analytics = CONNECTION
  ? new Pool({ connectionString: CONNECTION, max: 4, connectionTimeoutMillis: 8000 })
  : null;

export function analyticsEnabled(): boolean {
  return analytics !== null;
}

const DDL = `
CREATE TABLE IF NOT EXISTS servers (
  alias       TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  ip          TEXT NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS server_samples (
  id                BIGSERIAL PRIMARY KEY,
  ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
  alias             TEXT NOT NULL,
  ip                TEXT NOT NULL,
  reachable         BOOLEAN NOT NULL,
  cpu_percent       DOUBLE PRECISION,
  mem_used_bytes    BIGINT,
  mem_total_bytes   BIGINT,
  mem_percent       DOUBLE PRECISION,
  disk_percent      DOUBLE PRECISION,
  load1             DOUBLE PRECISION,
  apps              INTEGER,
  open_deployments  INTEGER,
  error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_samples_alias_ts ON server_samples(alias, ts DESC);

CREATE TABLE IF NOT EXISTS waha_checks (
  id        BIGSERIAL PRIMARY KEY,
  ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
  alias     TEXT NOT NULL,
  instance  TEXT NOT NULL,
  domain    TEXT,
  http_ok   BOOLEAN NOT NULL,
  dns_ok    BOOLEAN NOT NULL,
  engine    TEXT,
  version   TEXT,
  error     TEXT
);
CREATE INDEX IF NOT EXISTS idx_checks_alias_ts ON waha_checks(alias, ts DESC);
CREATE INDEX IF NOT EXISTS idx_checks_instance ON waha_checks(instance, ts DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id          BIGSERIAL PRIMARY KEY,
  key         TEXT NOT NULL,
  severity    TEXT NOT NULL,
  title       TEXT NOT NULL,
  detail      TEXT,
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_incidents_opened ON incidents(opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_key ON incidents(key);

CREATE TABLE IF NOT EXISTS actions (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  chat_id     BIGINT,
  user_id     BIGINT,
  command     TEXT NOT NULL,
  args        JSONB,
  result      TEXT,
  ok          BOOLEAN,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_actions_ts ON actions(ts DESC);

CREATE TABLE IF NOT EXISTS inventory (
  alias      TEXT NOT NULL,
  instance   TEXT NOT NULL,
  app_uuid   TEXT,
  fqdn       TEXT,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (alias, instance)
);
`;

export async function initAnalytics(
  log: (line: string, level?: 'info' | 'warn' | 'error') => void,
): Promise<void> {
  if (!analytics) {
    log('histórico deshabilitado (sin DATABASE_URL)', 'warn');
    return;
  }
  try {
    await analytics.query(DDL);
    log('histórico conectado a Postgres');
  } catch (err) {
    log(`no se pudo inicializar el histórico: ${(err as Error).message}`, 'error');
  }
}

function fire(promise: Promise<unknown>): void {
  void promise.catch(() => {});
}

export function recordSamples(snapshots: ServerSnapshot[]): void {
  if (!analytics || !snapshots.length) return;
  const values: unknown[] = [];
  const tuples = snapshots.map((s, i) => {
    const base = i * 13;
    values.push(
      s.alias,
      s.ip,
      s.reachable,
      s.metrics.cpuPercent,
      s.metrics.memUsedBytes,
      s.metrics.memTotalBytes,
      s.metrics.memPercent,
      s.metrics.diskPercent,
      s.metrics.load1,
      s.apps.length,
      s.openDeployments,
      s.lastError,
      new Date(s.collectedAt),
    );
    const p = (n: number) => `$${base + n}`;
    return `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},${p(11)},${p(12)},${p(13)})`;
  });
  fire(
    analytics.query(
      `INSERT INTO server_samples (alias, ip, reachable, cpu_percent, mem_used_bytes, mem_total_bytes,
        mem_percent, disk_percent, load1, apps, open_deployments, error, ts) VALUES ${tuples.join(',')}`,
      values,
    ),
  );
  fire(
    analytics.query(
      `INSERT INTO servers (alias, name, ip) VALUES ${snapshots
        .map((_, i) => `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3})`)
        .join(',')}
       ON CONFLICT (alias) DO UPDATE SET name = EXCLUDED.name, ip = EXCLUDED.ip, last_seen = now()`,
      snapshots.flatMap((s) => [s.alias, s.name, s.ip]),
    ),
  );
}

export function recordWahaChecks(alias: string, health: WahaHealth[]): void {
  if (!analytics || !health.length) return;
  const values: unknown[] = [];
  const tuples = health.map((h, i) => {
    const base = i * 8;
    values.push(alias, h.name, h.domain, h.httpOk, h.dnsOk, h.engine, h.version, h.error);
    const p = (n: number) => `$${base + n}`;
    return `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)})`;
  });
  fire(
    analytics.query(
      `INSERT INTO waha_checks (alias, instance, domain, http_ok, dns_ok, engine, version, error)
       VALUES ${tuples.join(',')}`,
      values,
    ),
  );
}

export function recordInventory(alias: string, apps: Array<{ name: string; uuid: string; fqdn: string }>): void {
  if (!analytics || !apps.length) return;
  const values: unknown[] = [];
  const tuples = apps.map((a, i) => {
    const base = i * 4;
    values.push(alias, a.name, a.uuid, a.fqdn);
    const p = (n: number) => `$${base + n}`;
    return `(${p(1)},${p(2)},${p(3)},${p(4)})`;
  });
  fire(
    analytics.query(
      `INSERT INTO inventory (alias, instance, app_uuid, fqdn) VALUES ${tuples.join(',')}
       ON CONFLICT (alias, instance) DO UPDATE SET app_uuid = EXCLUDED.app_uuid, fqdn = EXCLUDED.fqdn, last_seen = now()`,
      values,
    ),
  );
}

export function recordIncidentOpen(key: string, severity: Severity, title: string, detail: string): void {
  if (!analytics) return;
  fire(analytics.query('INSERT INTO incidents (key, severity, title, detail) VALUES ($1,$2,$3,$4)', [key, severity, title, detail]));
}

export function recordIncidentResolved(key: string): void {
  if (!analytics) return;
  fire(
    analytics.query(
      `UPDATE incidents SET resolved_at = now()
        WHERE id = (SELECT id FROM incidents WHERE key = $1 AND resolved_at IS NULL ORDER BY id DESC LIMIT 1)`,
      [key],
    ),
  );
}

export function recordAction(a: {
  chatId: number;
  userId: number;
  command: string;
  args: unknown;
  result: string;
  ok: boolean;
  durationMs: number;
}): void {
  if (!analytics) return;
  fire(
    analytics.query(
      'INSERT INTO actions (chat_id, user_id, command, args, result, ok, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [a.chatId, a.userId, a.command, JSON.stringify(a.args ?? {}), a.result.slice(0, 2000), a.ok, a.durationMs],
    ),
  );
}

export interface StatsSummary {
  days: number;
  uptime: Array<{ alias: string; samples: number; uptime: number; cpuAvg: number | null; memAvg: number | null; diskAvg: number | null }>;
  alertsByDay: Array<{ day: string; severity: string; count: number }>;
  topAlerts: Array<{ title: string; severity: string; count: number }>;
  wahaAvailability: Array<{ alias: string; checks: number; ok: number; availability: number }>;
  actionsByDay: Array<{ day: string; command: string; count: number }>;
}

export async function loadStats(days = 7): Promise<StatsSummary | null> {
  if (!analytics) return null;
  const interval = `${Math.max(1, Math.min(days, 90))} days`;
  const [uptime, alertsByDay, topAlerts, waha, actions] = await Promise.all([
    analytics.query(
      `SELECT alias,
              count(*)::int AS samples,
              round(avg(CASE WHEN reachable THEN 1 ELSE 0 END) * 100, 2)::float AS uptime,
              round(avg(cpu_percent)::numeric, 2)::float AS cpu_avg,
              round(avg(mem_percent)::numeric, 2)::float AS mem_avg,
              round(avg(disk_percent)::numeric, 2)::float AS disk_avg
         FROM server_samples
        WHERE ts > now() - $1::interval
        GROUP BY alias ORDER BY alias`,
      [interval],
    ),
    analytics.query(
      `SELECT to_char(date_trunc('day', opened_at), 'YYYY-MM-DD') AS day, severity, count(*)::int AS count
         FROM incidents WHERE opened_at > now() - $1::interval
        GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC`,
      [interval],
    ),
    analytics.query(
      `SELECT title, severity, count(*)::int AS count
         FROM incidents WHERE opened_at > now() - $1::interval
        GROUP BY title, severity ORDER BY count DESC LIMIT 10`,
      [interval],
    ),
    analytics.query(
      `SELECT alias, count(*)::int AS checks,
              count(*) FILTER (WHERE http_ok)::int AS ok,
              round((count(*) FILTER (WHERE http_ok))::numeric * 100 / greatest(count(*), 1), 2)::float AS availability
         FROM waha_checks WHERE ts > now() - $1::interval
        GROUP BY alias ORDER BY alias`,
      [interval],
    ),
    analytics.query(
      `SELECT to_char(date_trunc('day', ts), 'YYYY-MM-DD') AS day, command, count(*)::int AS count
         FROM actions WHERE ts > now() - $1::interval
        GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC`,
      [interval],
    ),
  ]);

  return {
    days,
    uptime: uptime.rows.map((r) => ({
      alias: r.alias,
      samples: r.samples,
      uptime: r.uptime,
      cpuAvg: r.cpu_avg,
      memAvg: r.mem_avg,
      diskAvg: r.disk_avg,
    })),
    alertsByDay: alertsByDay.rows,
    topAlerts: topAlerts.rows,
    wahaAvailability: waha.rows,
    actionsByDay: actions.rows,
  };
}
