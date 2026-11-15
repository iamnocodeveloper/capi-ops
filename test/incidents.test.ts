import test from 'node:test';
import assert from 'node:assert/strict';
import { AlertEngine, inQuietHours, parseQuietHours, type QuietHours } from '../src/incidents.js';
import type { Db } from '../src/db.js';
import type { Finding } from '../src/rules.js';
import type { IncidentRow, Severity } from '../src/types.js';

class FakeDb {
  rows: IncidentRow[] = [];
  private nextId = 1;
  raw = {
    prepare: () => ({
      run: (detail: string, id: number) => {
        const row = this.rows.find((r) => r.id === id);
        if (row) row.detail = detail;
      },
    }),
  };

  openIncident(key: string): IncidentRow | undefined {
    return this.rows.find((r) => r.key === key && r.resolved_at === null);
  }

  createIncident(key: string, severity: Severity, title: string, detail: string): IncidentRow {
    const row: IncidentRow = {
      id: this.nextId++,
      key,
      severity,
      title,
      detail,
      opened_at: Date.now(),
      last_notified_at: Date.now(),
      resolved_at: null,
    };
    this.rows.push(row);
    return row;
  }

  touchIncident(id: number, detail: string, severity: Severity): void {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.detail = detail;
    row.severity = severity;
    row.last_notified_at = Date.now();
  }

  openIncidents(): IncidentRow[] {
    return this.rows.filter((r) => r.resolved_at === null);
  }

  resolveIncident(key: string): IncidentRow | null {
    const row = this.openIncident(key) ?? null;
    if (row) row.resolved_at = Date.now();
    return row;
  }
}

function build(db: FakeDb, opts: { quiet?: QuietHours | null; renotifyMs?: number } = {}) {
  const sent: Array<{ text: string; severity: Severity }> = [];
  const opened: string[] = [];
  const resolved: string[] = [];
  const engine = new AlertEngine(
    db as unknown as Db,
    async (text, severity) => {
      sent.push({ text, severity });
    },
    {
      renotifyMs: opts.renotifyMs ?? 60 * 60_000,
      quiet: opts.quiet ?? null,
      record: {
        opened: (key) => opened.push(key),
        resolved: (key) => resolved.push(key),
      },
    },
  );
  return { engine, sent, opened, resolved };
}

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  key: 'srv:capi1:cpu',
  severity: 'alta',
  title: 'CPU alta en Servidor 1',
  detail: 'CPU 90%',
  ...overrides,
});

test('parseQuietHours acepta una ventana válida y rechaza el resto', () => {
  assert.deepEqual(parseQuietHours('23:00-07:00'), { from: 23 * 60, to: 7 * 60 });
  assert.deepEqual(parseQuietHours(' 09:30 - 18:15 '), { from: 570, to: 1095 });
  assert.equal(parseQuietHours('23-07'), null);
  assert.equal(parseQuietHours(''), null);
});

test('inQuietHours entiende ventanas que cruzan medianoche', () => {
  const night = parseQuietHours('23:00-07:00');
  assert.equal(inQuietHours(night, new Date(2026, 10, 15, 23, 30)), true);
  assert.equal(inQuietHours(night, new Date(2026, 10, 15, 6, 59)), true);
  assert.equal(inQuietHours(night, new Date(2026, 10, 15, 7, 0)), false);
  assert.equal(inQuietHours(night, new Date(2026, 10, 15, 12, 0)), false);
  assert.equal(inQuietHours(null, new Date(2026, 10, 15, 23, 30)), false);
});

test('una ventana con el mismo inicio y fin no silencia', () => {
  assert.equal(inQuietHours(parseQuietHours('10:00-10:00'), new Date(2026, 10, 15, 10, 0)), false);
});

test('un hallazgo nuevo abre incidente y notifica una vez', async () => {
  const db = new FakeDb();
  const { engine, sent, opened } = build(db);

  await engine.reconcile([finding()]);

  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0]?.key, 'srv:capi1:cpu');
  assert.equal(sent.length, 1);
  assert.match(sent[0]?.text ?? '', /CPU alta/);
  assert.deepEqual(opened, ['srv:capi1:cpu']);
});

test('el mismo hallazgo dentro del cooldown no re-notifica y actualiza el detalle', async () => {
  const db = new FakeDb();
  const { engine, sent } = build(db);

  await engine.reconcile([finding()]);
  await engine.reconcile([finding({ detail: 'CPU 93%' })]);

  assert.equal(sent.length, 1);
  assert.equal(db.rows[0]?.detail, 'CPU 93%');
});

test('un cambio de severidad sí re-notifica', async () => {
  const db = new FakeDb();
  const { engine, sent } = build(db);

  await engine.reconcile([finding({ severity: 'media' })]);
  await engine.reconcile([finding({ severity: 'critica' })]);

  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.severity, 'critica');
  assert.equal(db.rows[0]?.severity, 'critica');
});

test('cuando el hallazgo desaparece se cierra y avisa la recuperación', async () => {
  const db = new FakeDb();
  const { engine, sent, resolved } = build(db);

  await engine.reconcile([finding()]);
  await engine.reconcile([]);

  assert.notEqual(db.rows[0]?.resolved_at, null);
  assert.equal(sent.length, 2);
  assert.match(sent[1]?.text ?? '', /Recuperado/);
  assert.deepEqual(resolved, ['srv:capi1:cpu']);
});

test('el horario silencioso frena lo no crítico pero deja pasar lo crítico', async () => {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const hhmm = (m: number) =>
    `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const quiet = parseQuietHours(`${hhmm(minutes - 10)}-${hhmm(minutes + 10)}`);
  assert.ok(quiet);

  const db = new FakeDb();
  const { engine, sent } = build(db, { quiet });

  await engine.reconcile([finding({ key: 'srv:capi1:load', severity: 'media' })]);
  assert.equal(sent.length, 0);
  assert.equal(db.rows.length, 1, 'el incidente se registra igual aunque no se notifique');

  await engine.reconcile([
    finding({ key: 'srv:capi1:load', severity: 'media' }),
    finding({ key: 'srv:capi1:down', severity: 'critica', title: 'Servidor caído' }),
  ]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.severity, 'critica');
});
