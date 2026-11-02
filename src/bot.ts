import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Bot, type Context, InlineKeyboard } from 'grammy';
import { telegramCfg } from './config.js';
import type { Db } from './db.js';
import { esc, fmtBytes, fmtPct, pre, severityIcon, table } from './format.js';
import { epAction, epCounts, epStateLabel, findEpService, type EpAction } from './easypanel.js';
import { installWaha, findApp, nextWahaNumber } from './installer.js';
import { isWaha } from './probe.js';
import { appLogs, controlApp, deleteApp, deployApp } from './ops.js';
import { checkWaha, listSessions } from './waha.js';
import {
  buildFleetEntry,
  defaultAlias,
  discoverCoolify,
  formatInstallerProgress,
  installCoolify,
  isCoolifyToken,
  isIpv4,
  nextWahaRange,
  onboardCoolify,
  parseInstallerLog,
  type SshTarget,
} from './provision.js';
import type {
  EasyPanelCfg,
  EpSnapshot,
  FleetCfg,
  PendingAction,
  ServerCfg,
  ServerSnapshot,
  Severity,
  StoredFleetServer,
  WahaHealth,
} from './types.js';
import type { StatsSummary } from './pg.js';

export interface BotDeps {
  db: Db;
  fleet: FleetCfg;
  snapshots: () => ServerSnapshot[];
  refresh: () => Promise<ServerSnapshot[]>;
  readOnly: () => boolean;
  setReadOnly: (value: boolean) => void;
  wahaKey: () => string;
  wahaHealth: () => Map<string, WahaHealth[]>;
  recordAction?: (a: {
    chatId: number;
    userId: number;
    command: string;
    args: unknown;
    result: string;
    ok: boolean;
    durationMs: number;
  }) => void;
  stats?: (days: number) => Promise<StatsSummary | null>;
  ep?: () => EpSnapshot | null;
  refreshEp?: () => Promise<EpSnapshot | null>;
  easyPanel?: () => EasyPanelCfg | null;
  // Alta de servidores desde el bot
  provisionCfg: () => ProvisionRuntime;
  addServer: (server: ServerCfg, addedBy: number) => void;
  removeServer: (alias: string) => boolean;
  hotServers: () => StoredFleetServer[];
  log: (line: string) => void;
}

/** Parámetros de SSH/config del alta, resueltos desde el entorno. */
export interface ProvisionRuntime {
  user: string;
  sshPort: number;
  keyPath: string;
  timeoutMs: number;
  projectName: string;
}

/** Asistente por chat para dar de alta un VPS virgen. */
interface ProvisionWizard {
  chatId: number;
  userId: number;
  step: 'ssh-user' | 'password' | 'confirm' | 'await-register';
  ip: string;
  alias: string;
  user: string;
  auth: 'key' | 'password';
  /** Solo en memoria: nunca se persiste ni se loguea. */
  password?: string;
  createdAt: number;
}

interface AuditEntry {
  chatId: number;
  userId: number;
  command: string;
  args: unknown;
  result: string;
  ok: boolean;
  durationMs: number;
}

function audit(deps: BotDeps, entry: AuditEntry): void {
  deps.db.addAction(entry);
  deps.recordAction?.(entry);
}

function resolveAlias(input: string, fleet: FleetCfg): string | null {
  const clean = input
    .toLowerCase()
    .replace(/^servidor\s+/, '')
    .replace(/^srv\s+/, '')
    .replace(/^server\s+/, '')
    .trim();
  if (!clean) return null;
  if (fleet.servers.some((s) => s.alias === clean)) return clean;
  const num = /^(\d{1,2})$/.exec(clean);
  if (num) {
    const alias = `capi${num[1]}`;
    if (fleet.servers.some((s) => s.alias === alias)) return alias;
  }
  return null;
}

const pending = new Map<string, PendingAction>();
const PENDING_TTL = 5 * 60_000;

/** Asistentes de alta en curso, por chat. Las contraseñas viven solo acá (memoria). */
const wizards = new Map<number, ProvisionWizard>();
const WIZARD_TTL = 15 * 60_000;

async function currentEp(deps: BotDeps): Promise<EpSnapshot | null> {
  if (deps.refreshEp) return deps.refreshEp();
  return deps.ep?.() ?? null;
}

function epHostLine(ep: EpSnapshot): string {
  if (!ep.reachable) return `sin respuesta — ${ep.lastError ?? 'error desconocido'}`;
  const counts = epCounts(ep);
  const uptime = ep.uptimeSeconds === null ? '–' : `${(ep.uptimeSeconds / 86_400).toFixed(1)} d`;
  return [
    `CPU ${fmtPct(ep.cpuPercent, 1)} · Mem ${fmtPct(ep.memPercent, 1)} · Disco ${fmtPct(ep.diskPercent, 1)}`,
    `load1 ${ep.load1?.toFixed(2) ?? '–'} · ${ep.cores ?? '?'} cores · uptime ${uptime}`,
    `servicios ${counts.up}/${ep.services.length} up${counts.down ? ` · ${counts.down} CAÍDOS` : ''}${counts.off ? ` · ${counts.off} off` : ''}`,
    ep.updateAvailable
      ? `actualización disponible${ep.updateVersion ? `: ${ep.updateVersion}` : ''}`
      : 'sin actualizaciones pendientes',
  ].join('\n');
}

export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(telegramCfg.token);

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (!chatId || !userId) return;
    if (!telegramCfg.allowedChats.includes(chatId) || !telegramCfg.allowedUsers.includes(userId)) {
      deps.log(`ignorado chat=${chatId} user=${userId} texto="${ctx.message?.text ?? ''}"`);
      if (telegramCfg.allowedChats.length === 0) {
        await ctx.reply(
          `Chat no autorizado.\nTu chat_id es ${chatId} y tu user_id es ${userId}.\nAgregalos a TG_ALLOWED_CHATS y TG_ALLOWED_USERS.`,
        );
      }
      return;
    }
    await next();
  });

  bot.command(['start', 'ayuda', 'help'], async (ctx) => {
    await ctx.reply(helpText(deps), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });

  bot.command('estado', async (ctx) => {
    const [snaps, ep] = await Promise.all([deps.refresh(), currentEp(deps)]);
    const incidents = deps.db.openIncidents();
    const rows = snaps.map((s) => [
      s.alias,
      s.reachable ? 'ok' : 'CAÍDO',
      fmtPct(s.metrics.cpuPercent),
      fmtPct(s.metrics.memPercent),
      fmtPct(s.metrics.diskPercent),
      String(s.apps.length),
    ]);
    const body = table(rows, ['srv', 'estado', 'cpu', 'mem', 'disco', 'apps']);
    const incidentLines = incidents.length
      ? incidents
          .slice(0, 8)
          .map((i) => `${severityIcon(i.severity)} ${esc(i.title)}`)
          .join('\n')
      : 'sin incidentes abiertos';
    const epBlock = ep
      ? [`<b>${esc(ep.name)}</b> (${esc(ep.alias)} · ${esc(ep.ip)})`, pre(epHostLine(ep))]
      : [];
    await ctx.reply(
      [`<b>Estado de la flota</b>`, pre(body), ...epBlock, `<b>Incidentes</b>\n${incidentLines}`].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('servidores', async (ctx) => {
    const snaps = deps.snapshots();
    const rows = snaps.map((s) => {
      const nums = s.apps
        .filter(isWaha)
        .map((a) => a.number as number)
        .sort((a, b) => a - b);
      const range = nums.length ? `waha${nums[0]}–waha${nums[nums.length - 1]}` : 'sin waha';
      return [s.alias, s.ip, String(s.apps.length), range];
    });
    await ctx.reply(pre(table(rows, ['srv', 'ip', 'apps', 'rango'])), { parse_mode: 'HTML' });
  });

  bot.command(['instancias', 'waha-list', 'lista'], async (ctx) => {
    const raw = (ctx.match ?? '').trim();
    const snaps = deps.snapshots();
    if (!snaps.length) {
      await ctx.reply('Todavía estoy recolectando datos, probá en unos segundos.');
      return;
    }

    const alias = raw ? resolveAlias(raw, deps.fleet) : null;
    if (raw && !alias) {
      const rows = deps.fleet.servers.map((s) => {
        const snap = snaps.find((x) => x.alias === s.alias);
        const count = snap ? snap.apps.filter(isWaha).length : 0;
        return `${s.alias} — ${s.ip} — ${count} instancias`;
      });
      await ctx.reply(
        [
          `No encontré "${esc(raw)}".`,
          'Uso: <code>/instancias capi4</code> (o <code>/instancias 4</code>), sin argumento muestra todo.',
          '',
          ...rows.map((r) => esc(r)),
        ].join('\n'),
        { parse_mode: 'HTML' },
      );
      return;
    }

    const targets = alias ? snaps.filter((s) => s.alias === alias) : snaps;
    const health = deps.wahaHealth();
    const blocks: string[] = [];
    let totalApps = 0;

    for (const snap of targets) {
      const apps = snap.apps.filter(isWaha).sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
      if (!apps.length) continue;
      totalApps += apps.length;

      const healthByName = new Map((health.get(snap.alias) ?? []).map((h) => [h.name, h]));
      let okHttp = 0;
      let dnsBad = 0;
      const rows = apps.map((app) => {
        const item = healthByName.get(app.name);
        let web = '?';
        if (item) {
          if (item.httpOk) {
            web = 'ok';
            okHttp++;
          } else if (!item.dnsOk) {
            web = 'sin dns';
            dnsBad++;
          } else {
            web = 'sin http';
          }
        }
        const state = app.status.startsWith('running') ? 'up' : app.status;
        return [app.name, state, web, app.domain];
      });

      const footer = [
        `${apps.length} instancias · ${okHttp} responden${dnsBad ? ` · ${dnsBad} sin DNS` : ''}`,
        snap.reachable ? '' : '⚠️ MCP sin respuesta',
      ]
        .filter(Boolean)
        .join(' · ');

      blocks.push(
        [
          `<b>${esc(snap.name)}</b> — ${snap.alias} (${snap.ip})`,
          pre(table(rows, ['instancia', 'cont.', 'web', 'dominio'])),
          esc(footer),
        ].join('\n'),
      );
    }

    if (!blocks.length) {
      await ctx.reply('No hay instancias WAHA para mostrar.');
      return;
    }

    const header = alias
      ? ''
      : `<b>Inventario WAHA</b> — ${totalApps} instancias en ${targets.length} servidores\n`;

    let buffer = header;
    for (const block of blocks) {
      if ((buffer + '\n' + block).length > 3900) {
        await ctx.reply(buffer.trim(), { parse_mode: 'HTML' });
        buffer = block;
      } else {
        buffer = buffer ? `${buffer}\n${block}` : block;
      }
    }
    if (buffer.trim()) await ctx.reply(buffer.trim(), { parse_mode: 'HTML' });
  });

  bot.command('salud', async (ctx) => {
    const alias = (ctx.match ?? '').trim();
    const snaps = await deps.refresh();
    const targets = alias
      ? snaps.filter((s) => s.alias === alias || s.name.toLowerCase() === alias.toLowerCase())
      : snaps;
    if (!targets.length) {
      await ctx.reply(`No encontré el servidor "${alias}". Probá /servidores.`);
      return;
    }
    const blocks = targets.map((s) => {
      const m = s.metrics;
      const lines = [
        `<b>${esc(s.name)}</b> (${s.alias} · ${s.ip})`,
        s.reachable ? 'MCP: ok' : `MCP: sin respuesta — ${esc(s.lastError ?? '')}`,
        `CPU ${fmtPct(m.cpuPercent, 1)} · Mem ${fmtPct(m.memPercent, 1)} (${fmtBytes(m.memUsedBytes)}/${fmtBytes(m.memTotalBytes)}) · Disco ${fmtPct(m.diskPercent, 1)}`,
        `load1 ${m.load1?.toFixed(2) ?? '–'} · deploys en curso ${s.openDeployments} · apps ${s.apps.length}`,
      ];
      if (s.unhealthy.length) lines.push(`unhealthy: ${esc(s.unhealthy.slice(0, 8).join(', '))}`);
      return lines.join('\n');
    });
    await ctx.reply(blocks.join('\n\n'), { parse_mode: 'HTML' });
  });

  bot.command('waha', async (ctx) => {
    const arg = (ctx.match ?? '').trim();
    const snaps = await deps.refresh();
    const found = findApp(snaps, arg);
    if (!found) {
      await ctx.reply(`No encontré "${arg}". Probá /buscar <texto> o /estado.`);
      return;
    }
    const { server, app } = found;
    const health = await checkWaha(app.name, app.domain, server.ip, deps.wahaKey());
    const sessions = await listSessions(app.domain, deps.wahaKey());
    const lines = [
      `<b>${esc(app.name)}</b> @ ${esc(server.alias)} (${server.ip})`,
      `app: <code>${app.uuid}</code>`,
      `dominio: https://${esc(app.domain)}`,
      `estado: ${esc(app.status)} · DNS ${health.dnsOk ? 'ok' : 'mal'} · HTTP ${health.httpOk ? 'ok' : 'falla'}`,
      `engine: ${esc(health.engine ?? '–')} · versión ${esc(health.version ?? '–')}`,
    ];
    if (sessions) {
      lines.push(
        sessions.length
          ? `sesiones:\n${sessions.map((s) => `  ${s.name}: ${s.status}`).join('\n')}`
          : 'sesiones: ninguna',
      );
    } else {
      lines.push('sesiones: no disponibles');
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.command('buscar', async (ctx) => {
    const q = (ctx.match ?? '').trim().toLowerCase();
    if (!q) {
      await ctx.reply('Uso: /buscar <texto>');
      return;
    }
    const snaps = deps.snapshots();
    const hits: string[] = [];
    for (const snap of snaps) {
      for (const app of snap.apps) {
        if (
          app.name.toLowerCase().includes(q) ||
          app.domain.toLowerCase().includes(q) ||
          app.uuid.includes(q)
        ) {
          hits.push(`${snap.alias} · ${app.name} · ${app.status} · ${app.domain}`);
        }
      }
    }
    await ctx.reply(hits.length ? pre(hits.slice(0, 30).join('\n')) : 'sin resultados', {
      parse_mode: 'HTML',
    });
  });

  bot.command(['ep', 'easypanel'], async (ctx) => {
    if (!deps.easyPanel?.()) {
      await ctx.reply('EasyPanel no está configurado (faltan EASYPANEL_URL y EASYPANEL_TOKEN).');
      return;
    }
    const ep = await currentEp(deps);
    if (!ep) {
      await ctx.reply('No pude leer el estado de EasyPanel.');
      return;
    }
    const down = ep.services.filter((s) => s.state === 'down');
    const lines = [`<b>${esc(ep.name)}</b> · ${esc(ep.url)}`, pre(epHostLine(ep))];
    if (down.length) {
      lines.push(
        `<b>Caídos</b>\n` +
          down
            .map((s) => `• ${esc(s.project)}/${esc(s.name)}${s.host ? ` — ${esc(s.host)}` : ''}`)
            .join('\n'),
      );
    } else {
      lines.push('Sin servicios caídos 🎉');
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.command(['eps', 'epservicios'], async (ctx) => {
    if (!deps.easyPanel?.()) {
      await ctx.reply('EasyPanel no está configurado (faltan EASYPANEL_URL y EASYPANEL_TOKEN).');
      return;
    }
    const filter = (ctx.match ?? '').trim().toLowerCase();
    const ep = await currentEp(deps);
    if (!ep) {
      await ctx.reply('No pude leer el estado de EasyPanel.');
      return;
    }
    const services = filter
      ? ep.services.filter((s) => `${s.project}/${s.name} ${s.host ?? ''}`.toLowerCase().includes(filter))
      : ep.services;
    if (!services.length) {
      await ctx.reply(filter ? `Sin servicios que coincidan con "${filter}".` : 'Sin servicios.');
      return;
    }

    const rows = services.map((s) => [
      `${s.project}/${s.name}`.slice(0, 34),
      epStateLabel(s),
      s.cpuPercent === null ? '–' : `${s.cpuPercent.toFixed(1)}%`,
      fmtBytes(s.memBytes),
      s.httpStatus === null ? '–' : String(s.httpStatus),
      s.host ?? '–',
    ]);

    const blocks: string[] = [];
    for (let i = 0; i < rows.length; i += 25) {
      blocks.push(
        pre(table(rows.slice(i, i + 25), ['proyecto/servicio', 'estado', 'cpu', 'mem', 'http', 'dominio'])),
      );
    }

    let buffer = `<b>EasyPanel · servicios</b> (${services.length})`;
    for (const block of blocks) {
      if ((buffer + '\n' + block).length > 3900) {
        await ctx.reply(buffer.trim(), { parse_mode: 'HTML' });
        buffer = block;
      } else {
        buffer = buffer ? `${buffer}\n${block}` : block;
      }
    }
    if (buffer.trim()) await ctx.reply(buffer.trim(), { parse_mode: 'HTML' });
  });

  bot.command(['epserv', 'epservicio'], async (ctx) => {
    if (!deps.easyPanel?.()) {
      await ctx.reply('EasyPanel no está configurado (faltan EASYPANEL_URL y EASYPANEL_TOKEN).');
      return;
    }
    const arg = (ctx.match ?? '').trim();
    if (!arg) {
      await ctx.reply('Uso: /epserv <cliente/servicio|servicio>  — ej: /epserv clientes/feroz-landing');
      return;
    }
    const ep = await currentEp(deps);
    const service = ep ? findEpService(ep, arg) : null;
    if (!ep || !service) {
      await ctx.reply(`No encontré "${esc(arg)}". Probá /eps.`, { parse_mode: 'HTML' });
      return;
    }
    const detail = [
      `tipo: ${service.type}`,
      `estado: ${epStateLabel(service)} (${service.actual}/${service.desired} contenedores)`,
      `cliente/proyecto: ${service.project}`,
      `habilitado: ${service.enabled ? 'si' : 'no'}`,
      service.url ? `url: ${service.url}` : 'url: sin dominio',
      service.httpStatus === null ? '' : `http: ${service.httpStatus} en ${service.httpMs} ms`,
      `cpu: ${service.cpuPercent === null ? '–' : `${service.cpuPercent.toFixed(1)}%`}`,
      `mem: ${fmtBytes(service.memBytes)}`,
    ]
      .filter(Boolean)
      .join('\n');
    await ctx.reply(
      [`<b>${esc(service.project)}/${esc(service.name)}</b>`, pre(detail)].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('epdeploy', async (ctx) => suggestEpWrite(ctx, deps, 'deploy', (ctx.match ?? '').trim()));
  bot.command('eprestart', async (ctx) => suggestEpWrite(ctx, deps, 'restart', (ctx.match ?? '').trim()));
  bot.command('epstop', async (ctx) => suggestEpWrite(ctx, deps, 'stop', (ctx.match ?? '').trim()));
  bot.command('epstart', async (ctx) => suggestEpWrite(ctx, deps, 'start', (ctx.match ?? '').trim()));

  bot.command(['stats', 'estadisticas'], async (ctx) => {
    const arg = (ctx.match ?? '').trim();
    const days = Math.min(Math.max(Number(arg) || 7, 1), 90);
    if (!deps.stats) {
      await ctx.reply('Histórico no configurado (falta DATABASE_URL en el servicio).');
      return;
    }
    let summary: StatsSummary | null = null;
    try {
      summary = await deps.stats(days);
    } catch (err) {
      await ctx.reply(`No pude leer el histórico: ${(err as Error).message}`);
      return;
    }
    if (!summary) {
      await ctx.reply('Histórico no configurado.');
      return;
    }
    if (!summary.uptime.length) {
      await ctx.reply(`Sin datos en los últimos ${days} días todavía.`);
      return;
    }

    const uptimeRows = summary.uptime.map((u) => [
      u.alias,
      `${u.uptime.toFixed(2)}%`,
      String(u.samples),
      u.cpuAvg === null ? '–' : `${u.cpuAvg.toFixed(0)}%`,
      u.memAvg === null ? '–' : `${u.memAvg.toFixed(0)}%`,
      u.diskAvg === null ? '–' : `${u.diskAvg.toFixed(0)}%`,
    ]);

    const wahaRows = summary.wahaAvailability.map((w) => [
      w.alias,
      `${w.availability.toFixed(1)}%`,
      String(w.checks),
    ]);

    const top = summary.topAlerts.length
      ? summary.topAlerts
          .slice(0, 8)
          .map((a) => `${severityIcon(a.severity as Severity)} ${esc(a.title)} ×${a.count}`)
          .join('\n')
      : 'sin alertas';

    const days7 = summary.alertsByDay.slice(0, 10).map((d) => `${d.day}  ${d.severity.padEnd(7)} ${d.count}`);

    const blocks = [
      `<b>Estadísticas · últimos ${days} días</b>`,
      '',
      '<b>Uptime por servidor</b>',
      pre(table(uptimeRows, ['srv', 'uptime', 'muestras', 'cpu', 'mem', 'disco'])),
      '',
      '<b>Disponibilidad WAHA</b>',
      wahaRows.length ? pre(table(wahaRows, ['srv', 'http ok', 'chequeos'])) : 'sin chequeos',
      '',
      '<b>Alertas más frecuentes</b>',
      top,
      days7.length ? `\n<b>Alertas por día</b>\n${pre(days7.join('\n'))}` : '',
    ];

    await ctx.reply(blocks.filter(Boolean).join('\n'), { parse_mode: 'HTML' });
  });

  bot.command('incidentes', async (ctx) => {
    const incidents = deps.db.openIncidents();
    if (!incidents.length) {
      await ctx.reply('Sin incidentes abiertos 🎉');
      return;
    }
    const body = incidents
      .map(
        (i) =>
          `${severityIcon(i.severity)} <b>${esc(i.title)}</b>\n${pre(i.detail)}\n<i>${new Date(i.opened_at).toLocaleString('es-AR')}</i>`,
      )
      .join('\n\n');
    await ctx.reply(body, { parse_mode: 'HTML' });
  });

  bot.command('auditoria', async (ctx) => {
    const rows = deps.db.recentActions(12).map((a) => [
      new Date(a.ts).toLocaleTimeString('es-AR'),
      String(a.user_id),
      a.command,
      a.ok ? 'ok' : 'error',
    ]);
    const hot = deps.hotServers();
    const lines = [pre(table(rows, ['hora', 'user', 'comando', 'res']))];
    if (hot.length) {
      lines.push(
        `<b>Servidores en caliente</b> (${hot.length}): ${hot.map((s) => esc(s.alias)).join(', ')}`,
        '⚠️ Guardan su token de equipo en la base local (data/state.sqlite); nunca se escribe en los logs.',
      );
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.command('modo', async (ctx) => {
    const arg = (ctx.match ?? '').trim().toLowerCase();
    if (arg === 'solo-lectura') {
      deps.setReadOnly(true);
      await ctx.reply('Modo solo-lectura activado. No se ejecutarán acciones.');
    } else if (arg === 'normal') {
      deps.setReadOnly(false);
      await ctx.reply('Modo normal. Acciones habilitadas.');
    } else {
      await ctx.reply(`Modo actual: ${deps.readOnly() ? 'solo-lectura' : 'normal'}\nUso: /modo solo-lectura | /modo normal`);
    }
  });

  bot.command('logs', async (ctx) => {
    const parts = (ctx.match ?? '').trim().split(/\s+/);
    const target = parts[0] ?? '';
    const lines = Number(parts[1] ?? 60);
    const snaps = await deps.refresh();
    const found = findApp(snaps, target);
    if (!found) {
      await ctx.reply(`No encontré "${target}".`);
      return;
    }
    const server = deps.fleet.servers.find((s) => s.alias === found.server.alias);
    if (!server) {
      await ctx.reply('Servidor desconocido.');
      return;
    }
    try {
      const logs = await appLogs(server, found.app.uuid, Number.isFinite(lines) ? lines : 60);
      await ctx.reply(pre(logs.slice(-3500)), { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`Error leyendo logs: ${(err as Error).message}`);
    }
  });

  bot.command('instalar', async (ctx) => {
    if (deps.readOnly()) {
      await ctx.reply('Modo solo-lectura activo.');
      return;
    }
    const parts = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts[0] !== 'waha') {
      await ctx.reply('Uso: /instalar waha [cantidad] [servidor]  — ej: /instalar waha 2 capi4');
      return;
    }
    const count = Math.min(Number(parts[1] ?? 1) || 1, 5);
    const serverAlias = parts[2];
    const snaps = await deps.refresh();
    const startNumber = nextWahaNumber(deps.db, snaps);

    await ctx.reply(
      `Instalando ${count} WAHA desde waha${startNumber}${serverAlias ? ` en ${serverAlias}` : ' (servidor automático)'}…`,
    );

    const progress: string[] = [];
    try {
      const outcomes = await installWaha(deps.db, deps.fleet, {
        count,
        serverAlias,
        snapshots: snaps,
        onProgress: (line) => progress.push(line),
      });
      const lines = outcomes.map((o) => {
        if (o.error) return `❌ waha${o.number}: ${o.error}`;
        const extra = [
          o.deployStatus ? `deploy ${o.deployStatus}` : null,
          o.httpOk ? `HTTP ok${o.engine ? ` (${o.engine})` : ''}` : 'HTTP sin respuesta',
          o.dnsOk ? 'DNS ok' : 'DNS pendiente',
        ]
          .filter(Boolean)
          .join(' · ');
        return `✅ waha${o.number} en ${o.alias} (${o.ip})\nhttps://${o.domain}\n${extra}\napp <code>${o.appUuid}</code>`;
      });
      await ctx.reply(
        [`<b>Resultado</b>`, ...lines, '', pre(progress.slice(-10).join('\n'))].join('\n'),
        { parse_mode: 'HTML' },
      );
      audit(deps, {
        chatId: ctx.chat.id,
        userId: ctx.from?.id ?? 0,
        command: 'instalar',
        args: { count, serverAlias },
        result: lines.join(' | '),
        ok: outcomes.every((o) => !o.error),
        durationMs: 0,
      });
    } catch (err) {
      await ctx.reply(`Error instalando: ${(err as Error).message}`);
    }
  });

  // ── Alta de servidores ───────────────────────────────────────
  bot.command('servidor', async (ctx) => {
    const parts = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
    const sub = (parts[0] ?? '').toLowerCase();
    if (sub === 'nuevo') return startServerWizard(ctx, deps, parts.slice(1));
    if (sub === 'agregar') return addExistingServer(ctx, deps, parts.slice(1));
    if (sub === 'quitar') return removeServerAction(ctx, deps, parts.slice(1));
    if (sub === 'listo') return finishOnboarding(ctx, deps);
    if (sub === 'cancelar') {
      if (wizards.delete(ctx.chat.id)) await ctx.reply('Asistente cancelado.');
      else await ctx.reply('No había un asistente en curso.');
      return;
    }
    await ctx.reply(
      [
        '<b>Alta de servidores</b>',
        '/servidor nuevo &lt;ip&gt; [alias] — instala Coolify en un VPS virgen',
        '/servidor agregar &lt;alias&gt; &lt;ip&gt; &lt;token&gt; — da de alta un Coolify existente',
        '/servidor quitar &lt;alias&gt; — saca un servidor de la flota',
        '/servidor listo — continúa el alta tras crear la cuenta raíz',
        '/servidor cancelar — aborta el asistente',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('deploy', async (ctx) => suggestWrite(ctx, deps, 'deploy', (ctx.match ?? '').trim()));
  bot.command('restart', async (ctx) => suggestWrite(ctx, deps, 'restart', (ctx.match ?? '').trim()));
  bot.command('stop', async (ctx) => suggestWrite(ctx, deps, 'stop', (ctx.match ?? '').trim()));
  bot.command('delete', async (ctx) => suggestWrite(ctx, deps, 'delete', (ctx.match ?? '').trim()));

  bot.callbackQuery(/^(ok|no):(.+)$/, async (ctx) => {
    const data = ctx.match?.[2] ?? '';
    const action = pending.get(data);
    await ctx.answerCallbackQuery();
    if (!action) {
      await ctx.editMessageText('Confirmación expirada.');
      return;
    }
    if (ctx.match?.[1] === 'no') {
      pending.delete(data);
      await ctx.editMessageText('Cancelado.');
      return;
    }
    if (action.command === 'delete') {
      action.stage = 'typed';
      action.createdAt = Date.now();
      pending.set(data, action);
      await ctx.editMessageText(
        `Para confirmar el borrado escribí exactamente:\nCONFIRMAR ${String(action.args['name'] ?? '')}`,
      );
      return;
    }
    pending.delete(data);
    await ctx.editMessageText('Ejecutando…');
    await runAction(ctx, deps, action);
  });

  // Asistente de alta: elección de autenticación, confirmación y cancelación.
  bot.callbackQuery(/^wiz:auth:(key|pass):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = Number(ctx.match?.[2]);
    if (ctx.chat?.id !== chatId) {
      await ctx.editMessageText('No es tu asistente.');
      return;
    }
    const wiz = wizards.get(chatId);
    if (!wiz) {
      await ctx.editMessageText('El asistente expiró. Empezá de nuevo con /servidor nuevo.');
      return;
    }
    wiz.auth = ctx.match?.[1] === 'pass' ? 'password' : 'key';
    if (wiz.auth === 'password') {
      wiz.step = 'password';
      wizards.set(chatId, wiz);
      await ctx.editMessageText(
        `Mandá la contraseña SSH de ${wiz.user}@${wiz.ip} en el próximo mensaje.\n` +
          'No la guardo en disco ni en los logs (borro el mensaje en cuanto la recibo).',
      );
      return;
    }
    const cfg = deps.provisionCfg();
    if (!cfg.keyPath) {
      await ctx.editMessageText('No hay llave configurada (falta PROVISION_SSH_KEY_PATH). Elegí contraseña.');
      return;
    }
    wiz.step = 'confirm';
    wizards.set(chatId, wiz);
    await ctx.editMessageText(confirmSummary(wiz), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('✅ Instalar Coolify', `wiz:go:${chatId}`)
        .text('✖️ Cancelar', `wiz:cancel:${chatId}`),
    });
  });

  bot.callbackQuery(/^wiz:go:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = Number(ctx.match?.[1]);
    if (ctx.chat?.id !== chatId) {
      await ctx.editMessageText('No es tu asistente.');
      return;
    }
    const wiz = wizards.get(chatId);
    if (!wiz) {
      await ctx.editMessageText('El asistente expiró.');
      return;
    }
    if (deps.readOnly()) {
      await ctx.editMessageText('Modo solo-lectura activo.');
      return;
    }
    await ctx.editMessageText('🔧 Instalando Coolify… tarda 2-5 minutos, te voy avisando.');
    await runInstall(ctx, deps, wiz);
  });

  bot.callbackQuery(/^wiz:cancel:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = Number(ctx.match?.[1]);
    if (ctx.chat?.id !== chatId) return;
    const wiz = wizards.get(chatId);
    if (wiz) wiz.password = undefined;
    wizards.delete(chatId);
    await ctx.editMessageText('Alta cancelada.');
  });

  bot.callbackQuery(/^wiz:rm:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const alias = ctx.match?.[1] ?? '';
    if (alias === '-') {
      await ctx.editMessageText('Cancelado.');
      return;
    }
    if (deps.readOnly()) {
      await ctx.editMessageText('Modo solo-lectura activo.');
      return;
    }
    const wasHot = deps.hotServers().some((s) => s.alias === alias);
    const ok = deps.removeServer(alias);
    audit(deps, {
      chatId: ctx.chat?.id ?? 0,
      userId: ctx.from?.id ?? 0,
      command: 'servidor quitar',
      args: { alias },
      result: ok ? `quitado ${alias}` : `no existía ${alias}`,
      ok,
      durationMs: 0,
    });
    await ctx.editMessageText(
      ok
        ? `✅ <b>${esc(alias)}</b> fuera de la flota${wasHot ? '' : ' (se mantiene en SERVERS_JSON hasta el reinicio)'}.`
        : `No pude quitar ${esc(alias)}.`,
      { parse_mode: 'HTML' },
    );
  });

  bot.on('message:text', async (ctx) => {
    const wizard = wizards.get(ctx.chat.id);
    if (wizard && wizard.userId === ctx.from?.id && Date.now() - wizard.createdAt < WIZARD_TTL) {
      const text = ctx.message.text.trim();

      if (wizard.step === 'ssh-user') {
        wizard.user = text || wizard.user;
        wizard.createdAt = Date.now();
        wizards.set(wizard.chatId, wizard);
        await ctx.reply(
          `Usuario SSH: <b>${esc(wizard.user)}</b>\n¿Cómo autentico en ${esc(wizard.ip)}?`,
          {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard()
              .text('🔑 Llave', `wiz:auth:key:${wizard.chatId}`)
              .text('🔒 Contraseña', `wiz:auth:pass:${wizard.chatId}`),
          },
        );
        return;
      }

      if (wizard.step === 'password') {
        wizard.password = text;
        wizard.step = 'confirm';
        wizard.createdAt = Date.now();
        wizards.set(wizard.chatId, wizard);
        // borramos el mensaje con la contraseña para no dejarla en el historial
        await ctx.deleteMessage().catch(() => undefined);
        await ctx.reply(confirmSummary(wizard), {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('✅ Instalar Coolify', `wiz:go:${wizard.chatId}`)
            .text('✖️ Cancelar', `wiz:cancel:${wizard.chatId}`),
        });
        return;
      }

      if (wizard.step === 'await-register' && /^(listo|ok|ya|continuar|contin[uú]a)$/i.test(text)) {
        await finishOnboarding(ctx, deps);
        return;
      }
    }

    const text = ctx.message.text.trim();
    if (!text.toUpperCase().startsWith('CONFIRMAR ')) return;
    const wanted = text.slice('CONFIRMAR '.length).trim();
    for (const [id, action] of pending) {
      if (
        action.chatId === ctx.chat.id &&
        action.stage === 'typed' &&
        String(action.args['name'] ?? '') === wanted &&
        Date.now() - action.createdAt < PENDING_TTL
      ) {
        pending.delete(id);
        await ctx.reply('Borrando…');
        await runAction(ctx, deps, action);
        return;
      }
    }
    await ctx.reply('No hay un borrado pendiente que coincida (¿expiró?).');
  });

  bot.catch((err) => {
    deps.log(`bot error: ${err.message}`);
  });

  return bot;
}

async function suggestWrite(
  ctx: Context,
  deps: BotDeps,
  command: 'deploy' | 'restart' | 'stop' | 'delete',
  target: string,
): Promise<void> {
  if (deps.readOnly()) {
    await ctx.reply('Modo solo-lectura activo.');
    return;
  }
  if (!target) {
    await ctx.reply(`Uso: /${command} <wahaNN|uuid>`);
    return;
  }
  const snaps = await deps.refresh();
  const found = findApp(snaps, target);
  if (!found) {
    await ctx.reply(`No encontré "${target}".`);
    return;
  }
  const id = randomUUID().slice(0, 8);
  const action: PendingAction = {
    id,
    chatId: ctx.chat?.id ?? 0,
    userId: ctx.from?.id ?? 0,
    command,
    args: { name: found.app.name, uuid: found.app.uuid, alias: found.server.alias },
    description: `${command} ${found.app.name}`,
    createdAt: Date.now(),
    stage: 'confirm',
  };
  pending.set(id, action);
  const kb = new InlineKeyboard()
    .text('✅ Confirmar', `ok:${id}`)
    .text('✖️ Cancelar', `no:${id}`);
  await ctx.reply(
    `<b>${command}</b> sobre <b>${esc(found.app.name)}</b> @ ${esc(found.server.alias)} (${found.server.ip})\napp <code>${found.app.uuid}</code>`,
    { parse_mode: 'HTML', reply_markup: kb },
  );
}

async function suggestEpWrite(
  ctx: Context,
  deps: BotDeps,
  epActionName: EpAction,
  target: string,
): Promise<void> {
  if (deps.readOnly()) {
    await ctx.reply('Modo solo-lectura activo.');
    return;
  }
  if (!deps.easyPanel?.()) {
    await ctx.reply('EasyPanel no está configurado (faltan EASYPANEL_URL y EASYPANEL_TOKEN).');
    return;
  }
  if (!target) {
    await ctx.reply(`Uso: /ep${epActionName} <cliente/servicio|servicio>`);
    return;
  }
  const ep = await currentEp(deps);
  const service = ep ? findEpService(ep, target) : null;
  if (!service) {
    await ctx.reply(`No encontré "${esc(target)}". Probá /eps.`, { parse_mode: 'HTML' });
    return;
  }
  const id = randomUUID().slice(0, 8);
  const command = `ep${epActionName}`;
  const action: PendingAction = {
    id,
    chatId: ctx.chat?.id ?? 0,
    userId: ctx.from?.id ?? 0,
    command,
    args: {
      project: service.project,
      service: service.name,
      type: service.type,
      name: `${service.project}/${service.name}`,
    },
    description: `${epActionName} ${service.project}/${service.name}`,
    createdAt: Date.now(),
    stage: 'confirm',
  };
  pending.set(id, action);
  const kb = new InlineKeyboard()
    .text('✅ Confirmar', `ok:${id}`)
    .text('✖️ Cancelar', `no:${id}`);
  await ctx.reply(
    `<b>${epActionName}</b> sobre <b>${esc(service.project)}/${esc(service.name)}</b> (${esc(epStateLabel(service))})\n${service.url ? `${esc(service.url)}\n` : ''}tipo ${esc(service.type)}`,
    { parse_mode: 'HTML', reply_markup: kb },
  );
}

async function runAction(ctx: Context, deps: BotDeps, action: PendingAction): Promise<void> {
  if (action.command.startsWith('ep')) {
    const cfg = deps.easyPanel?.();
    const started = Date.now();
    try {
      if (!cfg) throw new Error('EasyPanel no está configurado');
      const result = await epAction(
        cfg,
        {
          project: String(action.args['project'] ?? ''),
          service: String(action.args['service'] ?? ''),
          type: String(action.args['type'] ?? ''),
        },
        action.command.slice(2) as EpAction,
      );
      audit(deps, {
        chatId: action.chatId,
        userId: action.userId,
        command: action.command,
        args: action.args,
        result,
        ok: true,
        durationMs: Date.now() - started,
      });
      await ctx.reply(`✅ ${result}`);
      void deps.refreshEp?.();
    } catch (err) {
      const message = (err as Error).message;
      audit(deps, {
        chatId: action.chatId,
        userId: action.userId,
        command: action.command,
        args: action.args,
        result: message,
        ok: false,
        durationMs: Date.now() - started,
      });
      await ctx.reply(`❌ ${action.command} falló: ${message}`);
    }
    return;
  }

  const alias = String(action.args['alias'] ?? '');
  const appUuid = String(action.args['uuid'] ?? '');
  const server: ServerCfg | undefined = deps.fleet.servers.find((s) => s.alias === alias);
  if (!server) {
    await ctx.reply('Servidor desconocido.');
    return;
  }
  const started = Date.now();
  try {
    let result = '';
    if (action.command === 'deploy') result = await deployApp(server, appUuid);
    else if (action.command === 'restart') result = await controlApp(server, appUuid, 'restart');
    else if (action.command === 'stop') result = await controlApp(server, appUuid, 'stop');
    else if (action.command === 'delete') result = await deleteApp(server, appUuid);
    else result = 'acción desconocida';
    audit(deps, {
      chatId: action.chatId,
      userId: action.userId,
      command: action.command,
      args: action.args,
      result,
      ok: true,
      durationMs: Date.now() - started,
    });
    await ctx.reply(`✅ ${action.command}: ${result}`);
    void deps.refresh();
  } catch (err) {
    const message = (err as Error).message;
    audit(deps, {
      chatId: action.chatId,
      userId: action.userId,
      command: action.command,
      args: action.args,
      result: message,
      ok: false,
      durationMs: Date.now() - started,
    });
    await ctx.reply(`❌ ${action.command} falló: ${message}`);
  }
}

function confirmSummary(wiz: ProvisionWizard): string {
  return [
    `<b>Instalar Coolify en ${esc(wiz.ip)}</b>`,
    `alias: ${esc(wiz.alias)}`,
    `usuario SSH: <code>${esc(wiz.user)}</code>`,
    `autenticación: ${wiz.auth === 'password' ? 'contraseña' : 'llave'}`,
    '',
    'Descargo y ejecuto el instalador oficial de Coolify. Al terminar te paso el enlace para crear la cuenta raíz.',
  ].join('\n');
}

/** Arma el destino SSH a partir del asistente y la config (llave del disco o contraseña en memoria). */
function buildTarget(wiz: ProvisionWizard, cfg: ProvisionRuntime): SshTarget {
  const target: SshTarget = { host: wiz.ip, port: cfg.sshPort, username: wiz.user || cfg.user };
  if (wiz.auth === 'password') {
    if (!wiz.password) throw new Error('falta la contraseña SSH');
    target.password = wiz.password;
  } else {
    if (!cfg.keyPath) throw new Error('no configuraste PROVISION_SSH_KEY_PATH para usar llave');
    try {
      target.privateKey = readFileSync(cfg.keyPath);
    } catch {
      throw new Error(`no pude leer la llave privada en ${cfg.keyPath}`);
    }
  }
  return target;
}

function altaOkMessage(entry: ServerCfg, range: [number, number]): string {
  return [
    `✅ <b>${esc(entry.alias)}</b> (${esc(entry.name)}) agregado a la flota en caliente.`,
    `MCP: <code>${esc(entry.url)}</code>`,
    `WAHA reservado: <b>waha${range[0]}–waha${range[1]}</b>`,
    '',
    '⚠️ El token del equipo quedó guardado en la base local (data/state.sqlite) para sobrevivir reinicios;',
    'no se escribe en los logs ni se muestra acá. Para sacarlo, /servidor quitar.',
  ].join('\n');
}

/** Inicia el asistente de alta de un VPS virgen. */
async function startServerWizard(ctx: Context, deps: BotDeps, args: string[]): Promise<void> {
  if (deps.readOnly()) {
    await ctx.reply('Modo solo-lectura activo.');
    return;
  }
  const ip = (args[0] ?? '').trim();
  if (!ip || !isIpv4(ip)) {
    await ctx.reply('Uso: /servidor nuevo <ip> [alias]  — ej: /servidor nuevo 203.0.113.10 capi5');
    return;
  }
  const alias = (args[1] ?? '').trim() || defaultAlias(deps.fleet.servers.map((s) => s.alias));
  if (deps.fleet.servers.some((s) => s.alias === alias)) {
    await ctx.reply(`El alias <b>${esc(alias)}</b> ya está en la flota. Probá otro.`, { parse_mode: 'HTML' });
    return;
  }
  const cfg = deps.provisionCfg();
  const chatId = ctx.chat?.id ?? 0;
  wizards.set(chatId, {
    chatId,
    userId: ctx.from?.id ?? 0,
    step: 'ssh-user',
    ip,
    alias,
    user: cfg.user,
    auth: 'key',
    createdAt: Date.now(),
  });
  await ctx.reply(
    [`🚀 <b>Alta de ${esc(alias)}</b> (${esc(ip)})`, 'Paso 1/3 · ¿Usuario SSH? (ej. <code>root</code>)'].join('\n'),
    { parse_mode: 'HTML' },
  );
}

/** Ejecuta la instalación de Coolify y avanza a la espera del registro. */
async function runInstall(ctx: Context, deps: BotDeps, wiz: ProvisionWizard): Promise<void> {
  const cfg = deps.provisionCfg();
  const started = Date.now();
  let target: SshTarget;
  try {
    target = buildTarget(wiz, cfg);
  } catch (err) {
    wizards.delete(wiz.chatId);
    await ctx.reply(`❌ ${(err as Error).message}`);
    return;
  }

  let lastPing = 0;
  const onProgress = (line: string): void => {
    if (Date.now() - lastPing < 12_000) return;
    lastPing = Date.now();
    void ctx.reply(`🔧 ${esc(line)}`, { parse_mode: 'HTML' }).catch(() => undefined);
  };

  try {
    const res = await installCoolify(target, { onProgress, timeoutMs: cfg.timeoutMs });
    if (!res.ok) {
      const parsed = parseInstallerLog(res.log);
      wiz.password = undefined;
      audit(deps, {
        chatId: wiz.chatId,
        userId: wiz.userId,
        command: 'servidor nuevo',
        args: { ip: wiz.ip, alias: wiz.alias, user: wiz.user },
        result: `instalador incompleto: ${formatInstallerProgress(parsed)}`,
        ok: false,
        durationMs: Date.now() - started,
      });
      await ctx.reply(
        `⚠️ El instalador no terminó a tiempo (${esc(formatInstallerProgress(parsed))}).\n` +
          `Revisá <code>/root/coolify-install.log</code> en ${esc(wiz.ip)} y volvé a intentar.`,
        { parse_mode: 'HTML' },
      );
      return;
    }
    wiz.step = 'await-register';
    wiz.createdAt = Date.now();
    wizards.set(wiz.chatId, wiz);
    audit(deps, {
      chatId: wiz.chatId,
      userId: wiz.userId,
      command: 'servidor nuevo',
      args: { ip: wiz.ip, alias: wiz.alias, user: wiz.user },
      result: 'coolify instalado',
      ok: true,
      durationMs: Date.now() - started,
    });
    await ctx.reply(
      [
        `✅ <b>Coolify instalado</b> en ${esc(wiz.ip)}`,
        '',
        `Creá la cuenta raíz en http://${esc(wiz.ip)}:8000/register`,
        'Tenés ~10 minutos; si se pasa, entrá por SSH y corré <code>docker restart coolify</code>.',
        '',
        'Cuando esté creada la cuenta, mandá <b>/servidor listo</b> (o simplemente «listo») y sigo con el alta.',
      ].join('\n'),
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
    );
  } catch (err) {
    wiz.password = undefined;
    wizards.delete(wiz.chatId);
    audit(deps, {
      chatId: wiz.chatId,
      userId: wiz.userId,
      command: 'servidor nuevo',
      args: { ip: wiz.ip, alias: wiz.alias, user: wiz.user },
      result: (err as Error).message,
      ok: false,
      durationMs: Date.now() - started,
    });
    await ctx.reply(`❌ Falló la instalación por SSH: ${(err as Error).message}`);
  }
}

/** Segunda mitad del asistente: onboarding de Coolify + alta en la flota. */
async function finishOnboarding(ctx: Context, deps: BotDeps): Promise<void> {
  if (deps.readOnly()) {
    await ctx.reply('Modo solo-lectura activo.');
    return;
  }
  const wiz = wizards.get(ctx.chat?.id ?? 0);
  if (!wiz || wiz.step !== 'await-register') {
    await ctx.reply('No hay un alta pendiente. Empezá con /servidor nuevo <ip> [alias].');
    return;
  }
  const cfg = deps.provisionCfg();
  const started = Date.now();
  await ctx.reply('⏳ Habilitando MCP y API, acuñando token y descubriendo UUIDs…');
  try {
    const target = buildTarget(wiz, cfg);
    const onb = await onboardCoolify(target, {
      onProgress: (line) => void ctx.reply(`· ${esc(line)}`, { parse_mode: 'HTML' }).catch(() => undefined),
      timeoutMs: cfg.timeoutMs,
      projectName: cfg.projectName,
    });
    const range = nextWahaRange(deps.fleet.servers.map((s) => s.wahaRange));
    const entry = buildFleetEntry({
      alias: wiz.alias,
      ip: wiz.ip,
      token: onb.token,
      projectUuid: onb.projectUuid,
      environmentName: onb.environmentName,
      serverUuid: onb.serverUuid,
      destinationUuid: onb.destinationUuid,
      wahaRange: range,
    });
    deps.addServer(entry, wiz.userId);
    audit(deps, {
      chatId: wiz.chatId,
      userId: wiz.userId,
      command: 'servidor nuevo',
      args: { ip: wiz.ip, alias: wiz.alias },
      result: 'alta completada',
      ok: true,
      durationMs: Date.now() - started,
    });
    await ctx.reply(altaOkMessage(entry, range), { parse_mode: 'HTML' });
  } catch (err) {
    audit(deps, {
      chatId: wiz.chatId,
      userId: wiz.userId,
      command: 'servidor nuevo',
      args: { ip: wiz.ip, alias: wiz.alias },
      result: (err as Error).message,
      ok: false,
      durationMs: Date.now() - started,
    });
    await ctx.reply(`❌ No pude completar el alta: ${(err as Error).message}`);
    return;
  }
  wiz.password = undefined;
  wizards.delete(wiz.chatId);
}

/** Alta de un Coolify ya instalado: descubre UUIDs con el token y da de alta. */
async function addExistingServer(ctx: Context, deps: BotDeps, args: string[]): Promise<void> {
  if (deps.readOnly()) {
    await ctx.reply('Modo solo-lectura activo.');
    return;
  }
  const alias = (args[0] ?? '').trim();
  const ip = (args[1] ?? '').trim();
  const token = (args[2] ?? '').trim();
  if (!alias || !ip || !token) {
    await ctx.reply('Uso: /servidor agregar <alias> <ip> <token de API>');
    return;
  }
  if (!isIpv4(ip)) {
    await ctx.reply('La IP no parece válida (formato IPv4).');
    return;
  }
  if (!isCoolifyToken(token)) {
    await ctx.reply('El token no tiene el formato esperado (id|secreto, ~50 chars).');
    return;
  }
  if (deps.fleet.servers.some((s) => s.alias === alias)) {
    await ctx.reply(`El alias <b>${esc(alias)}</b> ya está en la flota.`, { parse_mode: 'HTML' });
    return;
  }
  // el mensaje trae un token válido: lo borramos del chat para no dejarlo en el historial
  await ctx.deleteMessage().catch(() => undefined);
  const cfg = deps.provisionCfg();
  const started = Date.now();
  await ctx.reply(`⏳ Hablando con la API de Coolify en ${esc(ip)}…`, { parse_mode: 'HTML' });
  try {
    const disc = await discoverCoolify(ip, token, {
      projectName: cfg.projectName,
      onProgress: (line) => void ctx.reply(`· ${esc(line)}`, { parse_mode: 'HTML' }).catch(() => undefined),
    });
    const range = nextWahaRange(deps.fleet.servers.map((s) => s.wahaRange));
    const entry = buildFleetEntry({
      alias,
      ip,
      token,
      projectUuid: disc.projectUuid,
      environmentName: disc.environmentName,
      serverUuid: disc.serverUuid,
      destinationUuid: disc.destinationUuid,
      wahaRange: range,
    });
    deps.addServer(entry, ctx.from?.id ?? 0);
    audit(deps, {
      chatId: ctx.chat?.id ?? 0,
      userId: ctx.from?.id ?? 0,
      command: 'servidor agregar',
      args: { alias, ip },
      result: 'alta completada',
      ok: true,
      durationMs: Date.now() - started,
    });
    await ctx.reply(altaOkMessage(entry, range), { parse_mode: 'HTML' });
  } catch (err) {
    audit(deps, {
      chatId: ctx.chat?.id ?? 0,
      userId: ctx.from?.id ?? 0,
      command: 'servidor agregar',
      args: { alias, ip },
      result: (err as Error).message,
      ok: false,
      durationMs: Date.now() - started,
    });
    await ctx.reply(`❌ No pude dar de alta ${esc(alias)}: ${(err as Error).message}`, { parse_mode: 'HTML' });
  }
}

/** Pide confirmación para quitar un servidor de la flota. */
async function removeServerAction(ctx: Context, deps: BotDeps, args: string[]): Promise<void> {
  if (deps.readOnly()) {
    await ctx.reply('Modo solo-lectura activo.');
    return;
  }
  const alias = (args[0] ?? '').trim();
  if (!alias) {
    await ctx.reply('Uso: /servidor quitar <alias>');
    return;
  }
  if (!deps.fleet.servers.some((s) => s.alias === alias)) {
    await ctx.reply(`No tengo a <b>${esc(alias)}</b> en la flota. Probá /servidores.`, { parse_mode: 'HTML' });
    return;
  }
  const hot = deps.hotServers().some((s) => s.alias === alias);
  const kb = new InlineKeyboard().text('✅ Quitar', `wiz:rm:${alias}`).text('✖️ Cancelar', 'wiz:rm:-');
  await ctx.reply(
    [
      `¿Quitar <b>${esc(alias)}</b> de la flota?`,
      hot
        ? 'Es un alta en caliente: se borra su token de la base local.'
        : 'Viene de SERVERS_JSON: se saca solo de la sesión hasta el próximo reinicio.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: kb },
  );
}

function helpText(deps: BotDeps): string {
  return [
    '<b>capi-ops</b> — monitoreo y control de la flota',
    '',
    '<b>Consulta</b>',
    '/estado — resumen de los servidores',
    '/servidores — IP, apps y rango de WAHA',
    '/instancias &lt;srv&gt; — qué WAHA hay en un servidor (ej: /instancias 4)',
    '/salud [srv] — detalle de métricas',
    '/waha &lt;wahaNN|uuid&gt; — estado de una instancia',
    '/buscar &lt;texto&gt; — busca apps y dominios',
    '/logs &lt;wahaNN&gt; [líneas] — últimos logs',
    '/incidentes — incidentes abiertos',
    '/stats [días] — uptime, disponibilidad y alertas del histórico',
    '/auditoria — últimas acciones',
    '',
    '<b>EasyPanel</b>',
    '/ep — host, servicios caídos y actualización pendiente',
    '/eps [texto] — servicios con estado, CPU, HTTP y dominio',
    '/epserv &lt;cliente/servicio&gt; — detalle de un servicio',
    '',
    '<b>Acciones</b>',
    '/instalar waha [cantidad] [servidor]',
    '/deploy | /restart | /stop | /delete &lt;wahaNN|uuid&gt;',
    '/epdeploy | /eprestart | /epstop | /epstart &lt;cliente/servicio&gt;',
    '/modo solo-lectura | /modo normal',
    '',
    '<b>Servidores</b>',
    '/servidor nuevo &lt;ip&gt; [alias] — instala Coolify en un VPS virgen',
    '/servidor agregar &lt;alias&gt; &lt;ip&gt; &lt;token&gt; — alta de un Coolify existente',
    '/servidor quitar &lt;alias&gt; — saca un servidor de la flota',
    '',
    `Modo actual: <b>${deps.readOnly() ? 'solo-lectura' : 'normal'}</b>`,
  ].join('\n');
}
