import { randomUUID } from 'node:crypto';
import { Bot, type Context, InlineKeyboard } from 'grammy';
import { telegramCfg } from './config.js';
import type { Db } from './db.js';
import { esc, fmtBytes, fmtPct, pre, severityIcon, table } from './format.js';
import { epAction, epCounts, epStateLabel, findEpService, type EpAction } from './easypanel.js';
import { installWaha, findApp, nextWahaNumber } from './installer.js';
import { isWaha } from './probe.js';
import { appLogs, controlApp, deleteApp, deployApp } from './ops.js';
import { checkWaha, listSessions } from './waha.js';
import type {
  EasyPanelCfg,
  EpSnapshot,
  FleetCfg,
  PendingAction,
  ServerCfg,
  ServerSnapshot,
  Severity,
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
  log: (line: string) => void;
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
    `Modo actual: <b>${deps.readOnly() ? 'solo-lectura' : 'normal'}</b>`,
  ].join('\n');
}
