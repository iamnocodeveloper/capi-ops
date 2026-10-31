import { env, easyPanelCfg, loadFleet, paths, telegramCfg, thresholds, wahaApiKey } from './config.js';
import { Db } from './db.js';
import { epAsServerSnapshot, probeEasyPanel } from './easypanel.js';
import { AlertEngine, parseQuietHours } from './incidents.js';
import { createBot } from './bot.js';
import { startHttp } from './http.js';
import { isWaha, probeServer } from './probe.js';
import { evaluate, evaluateEasyPanel, type Finding } from './rules.js';
import { TelegramNotifier } from './telegram.js';
import { checkWaha, mapLimit } from './waha.js';
import type { EpSnapshot, FleetCfg, ServerSnapshot, WahaHealth } from './types.js';
import { refreshInventory } from './installer.js';
import {
  initAnalytics,
  loadStats,
  recordAction,
  recordIncidentOpen,
  recordIncidentResolved,
  recordInventory,
  recordSamples,
  recordWahaChecks,
} from './pg.js';

const startedAt = Date.now();
const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
const minLevel = levels[(env.LOG_LEVEL as keyof typeof levels) ?? 'info'] ?? 20;

function log(line: string, level: keyof typeof levels = 'info'): void {
  if (levels[level] < minLevel) return;
  const ts = new Date().toISOString();
  console.log(`${ts} ${level.toUpperCase().padEnd(5)} ${line}`);
}

const fleet: FleetCfg = loadFleet();
const epCfg = easyPanelCfg();
let epSnapshot: EpSnapshot | null = null;
const db = new Db(paths.db);
const notifier = new TelegramNotifier((l) => log(l, 'warn'));
const quiet = parseQuietHours(env.QUIET_HOURS);

const engine = new AlertEngine(db, (text, severity) => notifier.broadcast(text, severity), {
  renotifyMs: thresholds.renotifyMs,
  quiet,
  log: (l) => log(l, 'debug'),
  record: {
    opened: (key, severity, title, detail) => recordIncidentOpen(key, severity, title, detail),
    resolved: (key) => recordIncidentResolved(key),
  },
});

let snapshots: ServerSnapshot[] = [];
let lastRefreshAt = 0;
let lastCycleAt = 0;
let wahaHealth = new Map<string, WahaHealth[]>();
let wahaProbedAt = 0;
let readOnly = env.OPS_READ_ONLY;

async function collectSnapshots(): Promise<ServerSnapshot[]> {
  const results: ServerSnapshot[] = [];
  for (const server of fleet.servers) {
    try {
      results.push(await probeServer(server));
    } catch (err) {
      results.push({
        alias: server.alias,
        name: server.name,
        ip: server.ip,
        reachable: false,
        metrics: {
          online: false,
          cpuPercent: null,
          memUsedBytes: null,
          memTotalBytes: null,
          memPercent: null,
          diskPercent: null,
          load1: null,
          netRx: null,
          netTx: null,
        },
        apps: [],
        unhealthy: [],
        openDeployments: 0,
        lastError: (err as Error).message,
        collectedAt: Date.now(),
      });
    }
  }
  return results;
}

async function refresh(force = false): Promise<ServerSnapshot[]> {
  if (!force && Date.now() - lastRefreshAt < 3000 && snapshots.length) return snapshots;
  snapshots = await collectSnapshots();
  lastRefreshAt = Date.now();
  try {
    await refreshInventory(db, snapshots);
    for (const snap of snapshots) {
      recordInventory(
        snap.alias,
        snap.apps.map((a) => ({ name: a.name, uuid: a.uuid, fqdn: a.fqdn })),
      );
    }
  } catch (err) {
    log(`no se pudo refrescar inventario: ${(err as Error).message}`, 'warn');
  }
  return snapshots;
}

async function refreshEp(): Promise<EpSnapshot | null> {
  if (!epCfg) return null;
  epSnapshot = await probeEasyPanel(epCfg, { log: (line) => log(line, 'debug') });
  if (!epSnapshot.reachable) {
    log(`easypanel sin respuesta: ${epSnapshot.lastError ?? 'error desconocido'}`, 'warn');
  }
  return epSnapshot;
}

async function probeWahaFleet(force = false): Promise<void> {
  if (!force && Date.now() - wahaProbedAt < env.WAHA_PROBE_SECONDS * 1000) return;
  let key = '';
  try {
    key = wahaApiKey();
  } catch {
    return;
  }

  const tasks: Array<{ alias: string; name: string; domain: string; ip: string }> = [];
  for (const snap of snapshots) {
    for (const app of snap.apps.filter(isWaha)) {
      tasks.push({ alias: snap.alias, name: app.name, domain: app.domain, ip: snap.ip });
    }
  }
  if (!tasks.length) return;

  const started = Date.now();
  const results = await mapLimit(tasks, 16, (t) => checkWaha(t.name, t.domain, t.ip, key));

  const next = new Map<string, WahaHealth[]>();
  results.forEach((health, index) => {
    const alias = tasks[index]?.alias;
    if (!alias) return;
    const list = next.get(alias) ?? [];
    list.push(health);
    next.set(alias, list);
  });

  wahaHealth = next;
  wahaProbedAt = Date.now();
  for (const [alias, health] of next) recordWahaChecks(alias, health);
  log(`waha probe: ${tasks.length} dominios en ${Date.now() - started} ms`, 'debug');
}

async function cycle(): Promise<void> {
  const started = Date.now();
  try {
    const snaps = await refresh(true);
    const ep = await refreshEp();
    await probeWahaFleet(false);
    recordSamples(snaps);

    for (const snap of snaps) {
      if (snap.metrics.cpuPercent !== null || snap.metrics.memPercent !== null) {
        db.addMetric(snap.alias, {
          cpu: snap.metrics.cpuPercent,
          memPercent: snap.metrics.memPercent,
          diskPercent: snap.metrics.diskPercent,
          load1: snap.metrics.load1,
        });
      }
    }

    if (ep) {
      db.addMetric(ep.alias, {
        cpu: ep.cpuPercent,
        memPercent: ep.memPercent,
        diskPercent: ep.diskPercent,
        load1: ep.load1,
      });
      recordSamples([epAsServerSnapshot(ep)]);
    }

    const findings: Finding[] = [];
    const ctxBase = {
      thresholds: {
        cpu: thresholds.cpu,
        mem: thresholds.mem,
        diskWarn: thresholds.diskWarn,
        diskCrit: thresholds.diskCrit,
        load1: Number(process.env.LOAD1_THRESHOLD ?? 8),
      },
      wahaHealth,
      baseline: (alias: string, column: 'cpu' | 'mem_percent' | 'load1') => db.baseline(alias, column),
    };
    for (const snap of snaps) findings.push(...evaluate(snap, ctxBase));
    if (ep) findings.push(...evaluateEasyPanel(ep, ctxBase.thresholds, thresholds.epServiceCpu));

    await engine.reconcile(findings);
    lastCycleAt = Date.now();
    log(
      `ciclo ok en ${Date.now() - started} ms · ${snaps.length} servidores · ${findings.length} hallazgos · ${db.openIncidents().length} incidentes abiertos`,
      'debug',
    );
  } catch (err) {
    log(`ciclo falló: ${(err as Error).message}`, 'error');
  }

  await heartbeat();
  await maybeDigest();
}

async function heartbeat(): Promise<void> {
  if (!env.HEARTBEAT_URL) return;
  try {
    await fetch(env.HEARTBEAT_URL, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    log(`heartbeat falló: ${(err as Error).message}`, 'warn');
  }
}

async function maybeDigest(): Promise<void> {
  if (!env.DIGEST_AT) return;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (hhmm !== env.DIGEST_AT) return;
  const today = now.toISOString().slice(0, 10);
  if (db.getSetting('last_digest') === today) return;
  db.setSetting('last_digest', today);

  const rows = snapshots.map((s) =>
    [
      s.alias,
      s.reachable ? 'ok' : 'CAÍDO',
      `${s.metrics.cpuPercent?.toFixed(0) ?? '–'}%`,
      `${s.metrics.memPercent?.toFixed(0) ?? '–'}%`,
      `${s.metrics.diskPercent?.toFixed(0) ?? '–'}%`,
      String(s.apps.length),
    ].join(' · '),
  );
  const incidents = db.openIncidents();
  const epLines = epSnapshot
    ? [
        '',
        `<b>${epSnapshot.name}</b>`,
        [
          epSnapshot.reachable ? 'ok' : 'CAÍDO',
          `CPU ${epSnapshot.cpuPercent?.toFixed(0) ?? '–'}%`,
          `Mem ${epSnapshot.memPercent?.toFixed(0) ?? '–'}%`,
          `Disco ${epSnapshot.diskPercent?.toFixed(0) ?? '–'}%`,
          `${epSnapshot.services.filter((s) => s.state === 'up').length}/${epSnapshot.services.length} servicios up`,
        ].join(' · '),
        epSnapshot.updateAvailable
          ? `Actualización disponible${epSnapshot.updateVersion ? `: ${epSnapshot.updateVersion}` : ''}`
          : '',
      ].filter(Boolean)
    : [];
  const text = [
    '📊 <b>Digest diario</b>',
    '<pre>' + rows.join('\n') + '</pre>',
    ...epLines,
    incidents.length
      ? `<b>${incidents.length} incidentes abiertos</b>\n` + incidents.slice(0, 5).map((i) => `• ${i.title}`).join('\n')
      : 'Sin incidentes abiertos 🎉',
  ].join('\n');
  await notifier.broadcast(text, 'info');
}

const bot = telegramCfg.enabled
  ? createBot({
      db,
      fleet,
      snapshots: () => snapshots,
      refresh: () => refresh(true),
      readOnly: () => readOnly,
      setReadOnly: (v) => {
        readOnly = v;
        log(`modo solo-lectura: ${v}`, 'warn');
      },
      wahaKey: () => wahaApiKey(),
      wahaHealth: () => wahaHealth,
      recordAction,
      stats: (days: number) => loadStats(days),
      ep: () => epSnapshot,
      refreshEp,
      easyPanel: () => epCfg,
      log: (l) => log(l, 'warn'),
    })
  : null;

const http = startHttp({
  db,
  fleet,
  snapshots: () => snapshots,
  refresh: () => refresh(true),
  readOnly: () => readOnly,
  setReadOnly: (v) => {
    readOnly = v;
  },
  wahaKey: () => wahaApiKey(),
  wahaHealth: () => wahaHealth,
  recordAction,
  stats: (days: number) => loadStats(days),
  ep: () => epSnapshot,
  refreshEp,
  easyPanel: () => epCfg,
  log,
  startedAt,
  lastCycleAt: () => lastCycleAt,
  notify: async (text) => notifier.broadcast(text, 'info'),
});

async function main(): Promise<void> {
  log(`capi-ops arrancando · ${fleet.servers.length} servidores · telegram ${telegramCfg.enabled ? 'on' : 'off'} · solo-lectura ${readOnly}${epCfg ? ' · easypanel on' : ''}`);
  await initAnalytics((line, level) => log(line, level ?? 'info'));
  await cycle();

  setInterval(() => {
    void cycle();
  }, Math.max(env.POLL_SECONDS, 15) * 1000);

  setInterval(() => {
    db.pruneMetrics(30);
  }, 6 * 60 * 60 * 1000);

  if (telegramCfg.enabled && bot) {
    void bot.start({ drop_pending_updates: true, onStart: () => log('bot de telegram escuchando') });
    await notifier.broadcast('🚀 capi-ops arriba. Usá /ayuda para ver los comandos.', 'info');
  } else {
    log('TG_TOKEN vacío: el bot queda apagado (se imprimen las alertas en consola)', 'warn');
  }
}

const shutdown = (signal: string): void => {
  log(`cerrando por ${signal}`);
  http.close();
  void bot?.stop();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

void main();
