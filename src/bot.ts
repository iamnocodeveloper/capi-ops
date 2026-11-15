import { randomUUID } from 'node:crypto';
import { Bot, type Context, InlineKeyboard } from 'grammy';
import { telegramCfg } from './config.js';
import type { Db } from './db.js';
import { esc, fmtBytes, fmtPct, pre, severityIcon, table } from './format.js';
import { epAction, epCounts, epStateLabel, findEpService, type EpAction } from './easypanel.js';
import { installWaha, findApp, nextWahaNumber } from './installer.js';
import { isWaha } from './probe.js';
import { appLogs, controlApp, deleteApp, deployApp } from './ops.js';
import {
  checkWaha,
  listSessions,
  mapLimit,
  sessionPhone,
  sessionProxy,
  sessionWebhook,
} from './waha.js';
import {
  cleanLine,
  extractEvents,
  hostPublicIp,
  lineTimestamp,
  logsWindow,
  logoutEvents,
  networkInfo,
  pickReason,
  proxyByContainer,
  reasonInfo,
  relevantLines,
  resolveContainer,
  type DiagEvent,
  type ReasonCode,
} from './diagnostics.js';
import { hasSsh } from './ssh.js';
import { diagTimeZone, fmtArt, fmtArtDay, fmtArtTime, parseWhen, windowAround, type ParsedWhen } from './time.js';
import type {
  AppInfo,
  EasyPanelCfg,
  EpSnapshot,
  FleetCfg,
  Offices,
  PendingAction,
  ServerCfg,
  ServerSnapshot,
  Severity,
  WahaHealth,
  WahaSession,
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
  offices: Offices;
  log: (line: string) => void;
}

interface ResolvedInstance {
  snapshot: ServerSnapshot;
  app: AppInfo;
  server: ServerCfg;
}

const SHORT_REASONS: Record<ReasonCode, string> = {
  'primary-logged-out': '403 primary',
  'logout-other-device': '401 otro disp.',
  'device-removed': 'dispositivo removido',
  'logout-api': 'logout API',
  'logged-out': 'logout',
  'qr-expired': 'QR expirado',
  engine: 'motor',
  network: 'red/proxy',
  unknown: 'sin dato',
};

function findOffice(offices: Offices, input: string): { key: string; server: string; instance: string } | null {
  const wanted = input.toLowerCase().replace(/^oficina\s*/, '').replace(/^of\s*/, '').trim();
  for (const [key, target] of Object.entries(offices)) {
    const clean = key.toLowerCase().replace(/^oficina\s*/, '').replace(/^of\s*/, '').trim();
    if (clean === wanted) return { key, ...target };
  }
  return null;
}

/** Usa el snapshot del watcher (60 s) y solo sondea si todavía no hay datos. */
async function currentSnapshots(deps: BotDeps): Promise<ServerSnapshot[]> {
  const cached = deps.snapshots();
  return cached.length ? cached : deps.refresh();
}

function resolveInstance(
  deps: BotDeps,
  snapshots: ServerSnapshot[],
  input: string,
): ResolvedInstance | null {
  const office = findOffice(deps.offices, input);
  const target = office ? office.instance : input;
  const found = findApp(snapshots, target);
  if (!found) return null;
  const server = deps.fleet.servers.find((s) => s.alias === found.server.alias);
  if (!server) return null;
  return { snapshot: found.server, app: found.app, server };
}

/** Separa sesión / cuándo / ventana de los argumentos restantes. */
function splitDiagArgs(
  tokens: string[],
  sessionNames: string[],
): { session?: string; when?: string; window?: string } {
  const out: { session?: string; when?: string; window?: string } = {};
  const pending: string[] = [];
  for (const token of tokens) {
    const low = token.toLowerCase();
    const session = !out.session ? sessionNames.find((n) => n.toLowerCase() === low) : undefined;
    if (session) {
      out.session = session;
      continue;
    }
    if (pending.length > 0 && /^\d+[mh]$/.test(low)) {
      out.window = low;
      continue;
    }
    pending.push(token);
  }
  if (pending.length) out.when = pending.join(' ');
  return out;
}

function targetText(input: string): string {
  return esc(input);
}

function sessionActivity(session: WahaSession): number | null {
  const ts = session.timestamps?.activity;
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : null;
}

function sessionMeta(session: WahaSession): string {
  const phone = sessionPhone(session);
  const name = session.me?.pushName;
  const activity = sessionActivity(session);
  return [
    phone ? `tel +${phone}${name ? ` (${name})` : ''}` : 'sin teléfono',
    session.presence ? `presencia ${session.presence}` : null,
    activity ? `última actividad ${fmtArt(activity)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function eventLine(event: DiagEvent): string {
  const when = event.at ? fmtArtTime(event.at) : '--:--:--';
  return `[${when}] ${cleanLine(event.text).slice(0, 150)}`;
}

function sessionFromEvent(text: string): string | null {
  const match = /(?:session:|\[Session\/)([A-Za-z0-9._-]+)/.exec(text);
  return match?.[1] ?? null;
}

async function replyBlocks(ctx: Context, blocks: string[]): Promise<void> {
  let buffer = '';
  for (const block of blocks) {
    if (buffer && buffer.length + block.length + 2 > 3_900) {
      await ctx.reply(buffer, { parse_mode: 'HTML' });
      buffer = block;
    } else {
      buffer = buffer ? `${buffer}\n\n${block}` : block;
    }
  }
  if (buffer.trim()) await ctx.reply(buffer, { parse_mode: 'HTML' });
}

function artLogs(raw: string, limit: number): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      const ts = lineTimestamp(line);
      return ts === null ? cleanLine(line) : `[${fmtArtTime(ts)}] ${cleanLine(line)}`;
    })
    .join('\n');
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
    if (sessions === null) {
      lines.push('sesiones: no disponibles');
    } else if (!sessions.length) {
      lines.push('sesiones: ninguna');
    } else {
      const rows = sessions.map((s) => [
        s.name,
        s.status,
        sessionPhone(s) ? `+${sessionPhone(s)}` : '–',
        s.me?.pushName ?? '–',
        s.presence ?? '–',
        sessionActivity(s) ? fmtArt(sessionActivity(s) as number) : '–',
        sessionProxy(s) ?? '–',
      ]);
      lines.push(pre(table(rows, ['sesión', 'estado', 'tel', 'push', 'pres', 'actividad', 'proxy'])));
      const notes: string[] = [];
      for (const s of sessions) {
        const timelock = s.me?.reachoutTimelock;
        if (timelock?.isActive) {
          notes.push(
            `⚠️ ${s.name}: reachout timelock${timelock.timeEnforcementEnds ? ` hasta ${fmtArt(timelock.timeEnforcementEnds * 1000)}` : ''} — no reiniciar`,
          );
        }
        const capping = s.me?.messageCapping;
        if (capping?.cappingStatus && capping.cappingStatus !== 'NONE') {
          notes.push(
            `⚠️ ${s.name}: capping ${capping.cappingStatus} (${capping.usedQuota ?? '?'}/${capping.totalQuota ?? '?'}) — no reiniciar`,
          );
        }
      }
      if (notes.length) lines.push(notes.join('\n'));
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
    await ctx.reply(pre(table(rows, ['hora', 'user', 'comando', 'res'])), { parse_mode: 'HTML' });
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
    const parts = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
    const target = parts.shift() ?? '';
    if (!target) {
      await ctx.reply('Uso: /logs <wahaNN|uuid|oficina> [líneas] [desde..hasta]  — ej: /logs waha23 200 03/11 11:00..12:00');
      return;
    }
    let lines = 60;
    const timeParts: string[] = [];
    for (const part of parts) {
      if (/^\d+$/.test(part) && timeParts.length === 0) lines = Math.min(Math.max(Number(part), 10), 500);
      else timeParts.push(part);
    }

    const snaps = await deps.refresh();
    const inst = resolveInstance(deps, snaps, target);
    if (!inst) {
      await ctx.reply(`No encontré "${target}". Probá /buscar <texto> o /instancias.`);
      return;
    }

    const now = Date.now();
    let when: ParsedWhen | null = null;
    if (timeParts.length) {
      try {
        const [from, to] = timeParts.join(' ').split('..');
        const start = parseWhen(from, now, diagTimeZone());
        if (to) {
          const end = parseWhen(to, now, diagTimeZone());
          const since = start.point ?? start.since;
          const until = end.point ?? end.until;
          const fromLabel = start.point ? fmtArt(start.point) : start.label;
          const toLabel = end.point ? fmtArt(end.point) : end.label;
          when = { since, until, label: `${fromLabel} → ${toLabel}` };
        } else {
          when = start;
        }
      } catch (err) {
        await ctx.reply((err as Error).message);
        return;
      }
    }

    try {
      if (hasSsh(inst.server)) {
        const container = await resolveContainer(inst.server, inst.app.uuid);
        const raw = await logsWindow(inst.server, container, {
          since: when?.since ?? new Date(now - 3_600_000),
          until: when?.until ?? new Date(now),
          maxLines: Math.max(lines * 4, 400),
        });
        const body = artLogs(raw, lines);
        const header = `${esc(inst.app.name)} @ ${esc(inst.server.alias)} · ${when?.label ?? 'última hora'}`;
        await ctx.reply([`<b>${header}</b>`, pre(body || 'sin líneas en la ventana')].join('\n'), {
          parse_mode: 'HTML',
        });
      } else {
        const logs = await appLogs(inst.server, inst.app.uuid, lines);
        await ctx.reply(
          [`<b>${esc(inst.app.name)}</b> · sin SSH, últimas ${lines} líneas`, pre(logs.slice(-3500))].join('\n'),
          { parse_mode: 'HTML' },
        );
      }
    } catch (err) {
      await ctx.reply(`Error leyendo logs: ${(err as Error).message}`);
    }
  });

  bot.command(['sesiones', 'sessions'], async (ctx) => {
    const raw = (ctx.match ?? '').trim();
    if (!raw) {
      await ctx.reply('Uso: /sesiones <wahaNN|uuid|oficina>  — ej: /sesiones waha23');
      return;
    }
    const snaps = await currentSnapshots(deps);
    const inst = resolveInstance(deps, snaps, raw);
    if (!inst) {
      await ctx.reply(`No encontré "${targetText(raw)}". Probá /instancias o /oficinas.`, { parse_mode: 'HTML' });
      return;
    }
    const sessions = await listSessions(inst.app.domain, deps.wahaKey());
    if (sessions === null) {
      await ctx.reply(`No pude leer las sesiones de ${inst.app.name} (¿instancia caída o API key?).`);
      return;
    }
    if (!sessions.length) {
      await ctx.reply(`${inst.app.name} no tiene sesiones.`);
      return;
    }
    const failed = sessions.filter((s) => s.status === 'FAILED');
    const rows = sessions.map((s) => [
      s.name,
      s.status,
      sessionPhone(s) ? `+${sessionPhone(s)}` : '–',
      s.me?.pushName ?? '–',
      s.presence ?? '–',
      sessionActivity(s) ? fmtArt(sessionActivity(s) as number) : '–',
      sessionProxy(s) ?? '–',
    ]);
    const lines = [
      `<b>${esc(inst.app.name)}</b> @ ${esc(inst.server.alias)} — ${sessions.length} sesiones${failed.length ? ` · <b>${failed.length} FAILED</b>` : ''}`,
      pre(table(rows, ['sesión', 'estado', 'tel', 'push', 'pres', 'actividad', 'proxy'])),
    ];
    const notes: string[] = [];
    const webhooks = new Set<string>();
    for (const s of sessions) {
      const timelock = s.me?.reachoutTimelock;
      if (timelock?.isActive) {
        notes.push(
          `⚠️ ${s.name}: reachout timelock${timelock.timeEnforcementEnds ? ` hasta ${fmtArt(timelock.timeEnforcementEnds * 1000)}` : ''} — no reiniciar`,
        );
      }
      const capping = s.me?.messageCapping;
      if (capping?.cappingStatus && capping.cappingStatus !== 'NONE') {
        notes.push(
          `⚠️ ${s.name}: capping ${capping.cappingStatus} (${capping.usedQuota ?? '?'}/${capping.totalQuota ?? '?'}) — no reiniciar`,
        );
      }
      const webhook = sessionWebhook(s);
      if (webhook) webhooks.add(webhook);
    }
    if (webhooks.size) notes.push(`webhook: ${[...webhooks].join(', ')}`);
    if (notes.length) lines.push(notes.slice(0, 10).join('\n'));
    if (failed.length) lines.push('Para el motivo exacto: /diag ' + inst.app.name + ' <sesión>');
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.command(['diag', 'diagnostico'], async (ctx) => {
    const raw = (ctx.match ?? '').trim();
    if (!raw) {
      await ctx.reply(
        [
          'Uso: <code>/diag &lt;wahaNN|oficina&gt; [sesión] [cuándo] [±ventana]</code>',
          'Ejemplos:',
          '  /diag waha23 plp-3-res 11:30',
          '  /diag 23 plp-44 03/11 11:43 15m',
          '  /diag Oficina19 norte hoy',
          '  /diag waha23          (todas las FAILED)',
        ].join('\n'),
        { parse_mode: 'HTML' },
      );
      return;
    }

    const now = Date.now();
    const [targetArg, ...rest] = raw.split(/\s+/).filter(Boolean);
    const snaps = await currentSnapshots(deps);
    const inst = resolveInstance(deps, snaps, targetArg as string);
    if (!inst) {
      await ctx.reply(`No encontré "${targetText(targetArg as string)}". Probá /instancias o /oficinas.`, {
        parse_mode: 'HTML',
      });
      return;
    }

    const sessions = await listSessions(inst.app.domain, deps.wahaKey());
    if (sessions === null) {
      await ctx.reply(`No pude leer las sesiones de ${inst.app.name} (¿instancia caída o API key?).`);
      return;
    }

    const args = splitDiagArgs(rest, sessions.map((s) => s.name));
    let when: ParsedWhen;
    try {
      when = parseWhen(args.when, now, diagTimeZone());
      if (args.window && when.point) when = windowAround(when.point, args.window);
    } catch (err) {
      await ctx.reply((err as Error).message);
      return;
    }

    let targets = args.session
      ? sessions.filter((s) => s.name.toLowerCase() === args.session?.toLowerCase())
      : sessions.filter((s) => s.status === 'FAILED');
    if (args.session && !targets.length) {
      await ctx.reply(
        `No encontré la sesión "${args.session}" en ${inst.app.name}. Hay: ${sessions.map((s) => s.name).join(', ')}`,
      );
      return;
    }
    if (!targets.length) targets = sessions;
    if (!targets.length) {
      await ctx.reply(`${inst.app.name} no tiene sesiones.`);
      return;
    }

    const sshReady = hasSsh(inst.server);
    let container: string | null = null;
    let containerError: string | null = null;
    if (sshReady) {
      try {
        container = await resolveContainer(inst.server, inst.app.uuid);
      } catch (err) {
        containerError = (err as Error).message;
      }
    }
    let net: Awaited<ReturnType<typeof networkInfo>> | null = null;
    if (container) {
      try {
        net = await networkInfo(inst.server, container);
      } catch {
        net = null;
      }
    }

    const blocks: string[] = [];
    for (const session of targets.slice(0, 8)) {
      const lines: string[] = [
        `<b>${esc(inst.app.name)} · ${esc(session.name)} — ${esc(session.status)}</b>`,
        esc(sessionMeta(session)),
      ];
      if (!sshReady) {
        lines.push(`<i>SSH no configurado para ${esc(inst.server.alias)}: sin ventana histórica.</i>`);
      } else if (!container) {
        lines.push(`<i>No pude ubicar el contenedor: ${esc(containerError ?? 'desconocido')}</i>`);
      }

      let events: DiagEvent[] = [];
      let rawLogs = '';
      if (container) {
        try {
          rawLogs = await logsWindow(inst.server, container, { since: when.since, until: when.until });
          events = extractEvents(rawLogs, session.name);
        } catch (err) {
          lines.push(`<i>Error leyendo logs: ${esc((err as Error).message)}</i>`);
        }
      }
      if (!events.length) {
        try {
          const recent = await appLogs(inst.server, inst.app.uuid, 300);
          const fallback = extractEvents(recent, session.name);
          if (fallback.length) {
            events = fallback;
            lines.push('<i>Ventana sin eventos: motivo tomado de las últimas líneas del contenedor.</i>');
          }
        } catch {
          /* sin fallback */
        }
      }

      const picked = pickReason(events);
      const info = reasonInfo(picked.code);
      lines.push(`<b>Motivo:</b> ${esc(info.label)}`);
      if (picked.event?.at) lines.push(`<b>Cuándo:</b> ${esc(fmtArt(picked.event.at))}`);
      if (events.length) {
        lines.push('<b>Evidencia</b>', pre(events.slice(-6).map(eventLine).join('\n')));
      } else {
        lines.push(`<i>Sin eventos entre ${esc(when.label)}.</i>`);
      }
      const rel = relevantLines(rawLogs, session.name, 6);
      if (rel.length) lines.push(`<b>Log (${esc(when.label)})</b>`, pre(artLogs(rel.join('\n'), 6)));
      if (net) {
        const proxy = net.proxyVars.length ? net.proxyVars.join(', ') : 'sin proxy';
        const containerIp = net.containerIp && net.containerIp !== net.hostIp ? ` / contenedor ${net.containerIp}` : '';
        lines.push(`<b>Red:</b> egress ${esc(net.hostIp ?? '–')}${esc(containerIp)} · ${esc(proxy)}`);
      }
      if (sessionProxy(session)) lines.push(`<b>Proxy de sesión:</b> ${esc(sessionProxy(session) as string)}`);
      lines.push(`<b>Acción:</b> ${esc(info.action)}`);
      blocks.push(lines.join('\n'));
    }
    if (targets.length > 8) {
      blocks.push(`<i>… ${targets.length - 8} sesión(es) más. Pasá el nombre para ver una sola.</i>`);
    }
    await replyBlocks(ctx, blocks);
  });

  bot.command(['fallidas', 'failed'], async (ctx) => {
    const raw = (ctx.match ?? '').trim();
    const snaps = await currentSnapshots(deps);
    let serverAliases = new Set(deps.fleet.servers.map((s) => s.alias));
    if (raw) {
      const inst = resolveInstance(deps, snaps, raw);
      const alias = inst?.server.alias ?? resolveAlias(raw, deps.fleet);
      if (!alias) {
        await ctx.reply(`No encontré "${targetText(raw)}". Probá /servidores o /oficinas.`, { parse_mode: 'HTML' });
        return;
      }
      serverAliases = new Set([alias]);
    }

    const apps = snaps
      .filter((snap) => serverAliases.has(snap.alias))
      .flatMap((snap) => snap.apps.filter(isWaha).map((app) => ({ snap, app })));

    const perInstance = await mapLimit(apps, 6, async ({ snap, app }) => {
      const sessions = await listSessions(app.domain, deps.wahaKey(), 6_000);
      return { snap, app, failed: (sessions ?? []).filter((s) => s.status === 'FAILED') };
    });

    const failed = perInstance
      .flatMap((item) => item.failed.map((session) => ({ snap: item.snap, app: item.app, session })))
      .sort((a, b) => (sessionActivity(b.session) ?? 0) - (sessionActivity(a.session) ?? 0));
    if (!failed.length) {
      await ctx.reply(`Sin sesiones FAILED${raw ? ` en ${targetText(raw)}` : ''} 🎉`, { parse_mode: 'HTML' });
      return;
    }

    const decorated = await mapLimit(failed.slice(0, 6), 4, async (item) => {
      const serverCfg = deps.fleet.servers.find((s) => s.alias === item.snap.alias);
      if (!serverCfg || !hasSsh(serverCfg)) return { ...item, code: 'unknown' as ReasonCode, at: null as number | null };
      try {
        const container = await resolveContainer(serverCfg, item.app.uuid);
        const events = await logoutEvents(serverCfg, container, {
          session: item.session.name,
          days: 3,
          maxLines: 150,
        });
        const picked = pickReason(events);
        return { ...item, code: picked.code, at: picked.event?.at ?? null };
      } catch {
        return { ...item, code: 'unknown' as ReasonCode, at: null as number | null };
      }
    });

    const rows = decorated.map((d) => [
      d.app.name,
      d.session.name,
      sessionPhone(d.session) ? `+${sessionPhone(d.session)}` : '–',
      SHORT_REASONS[d.code],
      d.at ? `${fmtArtDay(d.at)} ${fmtArtTime(d.at)}` : '–',
    ]);
    const blocks = [
      `<b>Sesiones FAILED</b> (${failed.length})`,
      pre(table(rows, ['instancia', 'sesión', 'tel', 'motivo', 'desde'])),
    ];
    if (failed.length > 6) blocks.push(`<i>mostrando 6 de ${failed.length}; filtrá con /fallidas &lt;srv|oficina&gt;</i>`);
    await replyBlocks(ctx, blocks);
  });

  bot.command(['historial', 'historia'], async (ctx) => {
    const parts = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
    const target = parts.shift();
    if (!target) {
      await ctx.reply('Uso: /historial <wahaNN|oficina> [sesión] [días]  — ej: /historial waha20 5');
      return;
    }
    const snaps = await currentSnapshots(deps);
    const inst = resolveInstance(deps, snaps, target);
    if (!inst) {
      await ctx.reply(`No encontré "${targetText(target)}". Probá /instancias o /oficinas.`, { parse_mode: 'HTML' });
      return;
    }
    if (!hasSsh(inst.server)) {
      await ctx.reply(`SSH no configurado para ${inst.server.alias}: no puedo leer el historial de logs.`);
      return;
    }

    const sessions = await listSessions(inst.app.domain, deps.wahaKey());
    let session: string | undefined;
    let days = 5;
    for (const part of parts) {
      const match = sessions?.find((s) => s.name.toLowerCase() === part.toLowerCase());
      if (match) session = match.name;
      else if (/^\d+$/.test(part)) days = Math.min(Math.max(Number(part), 1), 30);
    }

    let container: string;
    try {
      container = await resolveContainer(inst.server, inst.app.uuid);
    } catch (err) {
      await ctx.reply(`No pude ubicar el contenedor: ${(err as Error).message}`);
      return;
    }

    let events: DiagEvent[];
    try {
      events = await logoutEvents(inst.server, container, { session, days });
    } catch (err) {
      await ctx.reply(`Error leyendo el historial: ${(err as Error).message}`);
      return;
    }
    if (!events.length) {
      await ctx.reply(`Sin eventos de logout/fallo en los últimos ${days} días${session ? ` para ${session}` : ''}.`);
      return;
    }

    const rows = events
      .slice()
      .reverse()
      .slice(0, 80)
      .map((event) => [
        event.at ? fmtArtDay(event.at) : '??',
        event.at ? fmtArtTime(event.at) : '--:--:--',
        sessionFromEvent(event.text) ?? session ?? '–',
        SHORT_REASONS[event.code],
      ]);
    await replyBlocks(ctx, [
      `<b>Historial ${esc(inst.app.name)}</b> · ${days} días${session ? ` · ${esc(session)}` : ''} · ${events.length} eventos`,
      pre(table(rows, ['día', 'hora', 'sesión', 'motivo'])),
    ]);
  });

  bot.command(['red', 'ip'], async (ctx) => {
    const raw = (ctx.match ?? '').trim();
    if (!raw) {
      await ctx.reply('Uso: /red <wahaNN|servidor|oficina>  — ej: /red waha23 o /red capi2');
      return;
    }
    const snaps = await currentSnapshots(deps);
    const inst = resolveInstance(deps, snaps, raw);

    if (inst) {
      if (!hasSsh(inst.server)) {
        await ctx.reply(`SSH no configurado para ${inst.server.alias}: no puedo leer la red del contenedor.`);
        return;
      }
      let container: string;
      try {
        container = await resolveContainer(inst.server, inst.app.uuid);
      } catch (err) {
        await ctx.reply(`No pude ubicar el contenedor: ${(err as Error).message}`);
        return;
      }
      try {
        const net = await networkInfo(inst.server, container);
        const sessions = await listSessions(inst.app.domain, deps.wahaKey());
        const blocks: string[] = [
          `<b>${esc(inst.app.name)}</b> @ ${esc(inst.server.alias)} (${esc(inst.server.ip)})`,
          `IP de salida del host: <code>${esc(net.hostIp ?? '–')}</code>`,
          `IP de salida del contenedor: <code>${esc(net.containerIp ?? '–')}</code>`,
          net.proxyVars.length
            ? `<b>Proxy del contenedor</b>\n${pre(net.proxyVars.join('\n'))}`
            : 'Proxy del contenedor: <b>sin proxy</b> (sale por la IP del host)',
        ];
        if (sessions?.length) {
          const rows = sessions.map((s) => [s.name, s.status, sessionProxy(s) ?? '–']);
          blocks.push('<b>Proxy por sesión</b>', pre(table(rows, ['sesión', 'estado', 'proxy'])));
        }
        await replyBlocks(ctx, blocks);
      } catch (err) {
        await ctx.reply(`Error consultando la red: ${(err as Error).message}`);
      }
      return;
    }

    const alias = resolveAlias(raw, deps.fleet);
    const serverCfg = alias ? deps.fleet.servers.find((s) => s.alias === alias) : undefined;
    if (!serverCfg) {
      await ctx.reply(`No encontré "${targetText(raw)}". Probá /servidores o /oficinas.`, { parse_mode: 'HTML' });
      return;
    }
    if (!hasSsh(serverCfg)) {
      await ctx.reply(`SSH no configurado para ${serverCfg.alias}.`);
      return;
    }
    try {
      const hostIp = await hostPublicIp(serverCfg);
      const proxies = await proxyByContainer(serverCfg);
      const rows = [...proxies.entries()].map(([name, vars]) => [
        name.slice(0, 26),
        vars.length ? vars.join(' ') : 'sin proxy',
      ]);
      await replyBlocks(ctx, [
        `<b>${esc(serverCfg.name)}</b> (${esc(serverCfg.alias)})`,
        `IP de salida del host: <code>${esc(hostIp ?? serverCfg.ip)}</code>`,
        pre(table(rows, ['contenedor', 'proxy'])),
      ]);
    } catch (err) {
      await ctx.reply(`Error consultando la red: ${(err as Error).message}`);
    }
  });

  bot.command(['oficinas', 'oficina'], async (ctx) => {
    const entries = Object.entries(deps.offices);
    if (!entries.length) {
      await ctx.reply(
        'Sin mapeo de oficinas. Creá config/oficinas.json (o OFFICES_JSON) con {"Oficina19":{"server":"capi2","instance":"waha20"}}.',
      );
      return;
    }
    const rows = entries.map(([name, target]) => [name, target.server, target.instance]);
    await ctx.reply(
      [`<b>Oficinas</b>`, pre(table(rows, ['oficina', 'servidor', 'instancia']))].join('\n'),
      { parse_mode: 'HTML' },
    );
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

  bot.on('message:text', async (ctx) => {
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

function helpText(deps: BotDeps): string {
  return [
    '<b>capi-ops</b> — monitoreo y control de la flota',
    '',
    '<b>Consulta</b>',
    '/estado — resumen de los servidores',
    '/servidores — IP, apps y rango de WAHA',
    '/instancias &lt;srv&gt; — qué WAHA hay en un servidor (ej: /instancias 4)',
    '/salud [srv] — detalle de métricas',
    '/waha &lt;wahaNN|uuid&gt; — estado de una instancia y sus sesiones',
    '/sesiones &lt;wahaNN|oficina&gt; — teléfono, presencia, actividad y proxy por sesión',
    '/diag &lt;wahaNN|oficina&gt; [sesión] [cuándo] — motivo exacto de un FAILED con log',
    '/fallidas [srv|oficina] — barrido de todas las sesiones FAILED',
    '/historial &lt;wahaNN&gt; [sesión] [días] — logouts con fecha y motivo',
    '/red &lt;wahaNN|srv|oficina&gt; — IP de salida y proxy',
    '/buscar &lt;texto&gt; — busca apps y dominios',
    '/logs &lt;wahaNN&gt; [líneas] [desde..hasta] — logs con ventana horaria',
    '/oficinas — mapeo oficina → servidor/instancia',
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
    `Modo actual: <b>${deps.readOnly() ? 'solo-lectura' : 'normal'}</b>`,
  ].join('\n');
}
