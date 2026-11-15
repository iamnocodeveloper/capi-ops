import { env, easyPanelCfg, loadFleet, loadOffices, mergeFleetServers, paths, provisionCfg, retention, telegramCfg, thresholds, wahaApiKey } from './config.js';
import { Db } from './db.js';
import { forgetClient } from './mcp.js';
import { epAsServerSnapshot, probeEasyPanel } from './easypanel.js';
import { AlertEngine, parseQuietHours } from './incidents.js';
import { createBot } from './bot.js';
import { startHttp } from './http.js';
import { isWaha, probeServer } from './probe.js';
import { evaluate, evaluateEasyPanel, type Finding } from './rules.js';
import { TelegramNotifier } from './telegram.js';
import { checkWaha, mapLimit } from './waha.js';
import type { EpSnapshot, FleetCfg, ServerCfg, ServerSnapshot, WahaHealth } from './types.js';
import { refreshInventory } from './installer.js';
import {
  initAnalytics,
  loadStats,
  pruneAnalytics,
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

const baseFleet: FleetCfg = loadFleet();
const offices = loadOffices();
const epCfg = easyPanelCfg();
let epSnapshot: EpSnapshot | null = null;
const db = new Db(paths.db);
// La flota es la base (SERVERS_JSON/archivo) más los servidores dados de alta en caliente (SQLite).
const fleet: FleetCfg = mergeFleetServers(baseFleet, db.fleetServers());
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

    if (!notifier.healthy()) {
      findings.push({
        key: 'ops:telegram',
        severity: 'critica',
        title: 'Bot de Telegram sin entregar',
        detail: notifier.describeProblem(),
      });
    }

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

/** Callbacks de alta/baja de servidores, compartidos por el bot y el HTTP. */
const serverAdmin = {
  provisionCfg: () => provisionCfg,
  addServer: (server: ServerCfg, addedBy: number): void => {
    db.addFleetServer({ ...server, addedBy, createdAt: Date.now() });
    const existing = fleet.servers.findIndex((s) => s.alias === server.alias);
    if (existing >= 0) fleet.servers[existing] = server;
    else fleet.servers.push(server);
    forgetClient(server.alias);
    // Sin secretos: solo alias e IP.
    log(`servidor añadido: ${server.alias} (${server.ip})`, 'warn');
    void refresh(true);
  },
  removeServer: (alias: string): boolean => {
    const removed = db.removeFleetServer(alias);
    const idx = fleet.servers.findIndex((s) => s.alias === alias);
    if (idx >= 0) fleet.servers.splice(idx, 1);
    forgetClient(alias);
    if (removed || idx >= 0) log(`servidor quitado: ${alias}`, 'warn');
    return removed || idx >= 0;
  },
  hotServers: () => db.fleetServers(),
};

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
      offices,
      ...serverAdmin,
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
  offices,
  ...serverAdmin,
  log,
  startedAt,
  lastCycleAt: () => lastCycleAt,
  telegramStatus: () => notifier.status(),
  notify: async (text) => notifier.broadcast(text, 'info'),
});

const BOT_COMMANDS = [
  { command: 'estado', description: 'Resumen de la flota y EasyPanel' },
  { command: 'servidores', description: 'IP, apps y rango de WAHA por servidor' },
  { command: 'instancias', description: 'Inventario de WAHA por servidor' },
  { command: 'salud', description: 'CPU, memoria, disco y deploys en curso' },
  { command: 'waha', description: 'Estado de una instancia y sus sesiones' },
  { command: 'sesiones', description: 'Teléfono, presencia, actividad y proxy por sesión' },
  { command: 'diag', description: 'Motivo de una sesión FAILED con extracto de log' },
  { command: 'fallidas', description: 'Barrido de todas las sesiones FAILED' },
  { command: 'historial', description: 'Logouts y fallos recientes del log retenido' },
  { command: 'red', description: 'IP de salida y proxy por contenedor y sesión' },
  { command: 'buscar', description: 'Busca aplicaciones y dominios en la flota' },
  { command: 'logs', description: 'Últimas líneas o una ventana horaria' },
  { command: 'oficinas', description: 'Mapeo oficina → servidor/instancia' },
  { command: 'incidentes', description: 'Incidentes abiertos' },
  { command: 'stats', description: 'Uptime y alertas del histórico' },
  { command: 'auditoria', description: 'Últimas acciones ejecutadas' },
  { command: 'ep', description: 'Host de EasyPanel y actualización pendiente' },
  { command: 'eps', description: 'Servicios de EasyPanel con estado y CPU' },
  { command: 'epserv', description: 'Detalle de un servicio de EasyPanel' },
  { command: 'instalar', description: 'Crea instancias WAHA' },
  { command: 'servidor', description: 'Alta de servidores Coolify (nuevo/agregar/quitar)' },
  { command: 'deploy', description: 'Despliega una instancia' },
  { command: 'restart', description: 'Reinicia una instancia' },
  { command: 'stop', description: 'Detiene una instancia' },
  { command: 'delete', description: 'Borra una instancia (pide confirmación)' },
  { command: 'epdeploy', description: 'Despliega un servicio de EasyPanel' },
  { command: 'eprestart', description: 'Reinicia un servicio de EasyPanel' },
  { command: 'epstop', description: 'Detiene un servicio de EasyPanel' },
  { command: 'epstart', description: 'Arranca un servicio de EasyPanel' },
  { command: 'modo', description: 'Alterna solo-lectura / normal' },
  { command: 'ayuda', description: 'Ayuda con todos los comandos' },
];

async function main(): Promise<void> {
  log(`capi-ops arrancando · ${fleet.servers.length} servidores · telegram ${telegramCfg.enabled ? 'on' : 'off'} · solo-lectura ${readOnly}${epCfg ? ' · easypanel on' : ''}`);
  await initAnalytics((line, level) => log(line, level ?? 'info'));
  await pruneAnalytics(retention, (line, level) => log(line, level ?? 'info'));
  await cycle();

  setInterval(() => {
    void cycle();
  }, Math.max(env.POLL_SECONDS, 15) * 1000);

  setInterval(() => {
    db.pruneMetrics(30);
  }, 6 * 60 * 60 * 1000);

  setInterval(() => {
    void pruneAnalytics(retention, (line, level) => log(line, level ?? 'info'));
  }, 24 * 60 * 60 * 1000);

  if (telegramCfg.enabled && bot) {
    void bot.api
      .setMyCommands(BOT_COMMANDS)
      .catch((err: Error) => log(`setMyCommands falló: ${err.message}`, 'warn'));

    // Sin `.catch`, un token inválido hace rechazar `bot.start()` y en Node 24 ese
    // rechazo no capturado termina el proceso: el servicio entra en crash loop y
    // deja de monitorear. Se registra el fallo y se mantiene el watcher vivo.
    bot
      .start({
        drop_pending_updates: true,
        onStart: () => {
          notifier.markPollingStarted();
          log('bot de telegram escuchando');
        },
      })
      .catch((err: Error) => notifier.markPollingError(err.message));

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

// Red de seguridad: un rechazo no capturado ya no debe matar el proceso. El ciclo
// del watcher y `/health` tienen que seguir vivos aunque Telegram falle.
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  log(`unhandledRejection: ${message}`, 'error');
  if (/getUpdates|Unauthorized|telegram/i.test(message)) {
    notifier.markPollingError(message);
  }
});

process.on('uncaughtException', (err) => {
  log(`uncaughtException: ${err.message}`, 'error');
});

void main().catch((err: Error) => {
  log(`main() falló: ${err.message}`, 'error');
});
