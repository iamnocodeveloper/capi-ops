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
  AppInfo,
  EasyPanelCfg,
  EpSnapshot,
  FleetCfg,
  Offices,
  PendingAction,
  ServerCfg,
  ServerSnapshot,
  Severity,
  StoredFleetServer,
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
    '<b>Servidores</b>',
    '/servidor nuevo &lt;ip&gt; [alias] — instala Coolify en un VPS virgen',
    '/servidor agregar &lt;alias&gt; &lt;ip&gt; &lt;token&gt; — alta de un Coolify existente',
    '/servidor quitar &lt;alias&gt; — saca un servidor de la flota',
    '',
    `Modo actual: <b>${deps.readOnly() ? 'solo-lectura' : 'normal'}</b>`,
  ].join('\n');
}
