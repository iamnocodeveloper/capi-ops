import { randomUUID } from 'node:crypto';
import { Bot, type Context, InlineKeyboard } from 'grammy';
import { telegramCfg } from './config.js';
import type { Db } from './db.js';
import { esc, fmtBytes, fmtPct, pre, severityIcon, table } from './format.js';
import { installWaha, findApp, nextWahaNumber } from './installer.js';
import { isWaha } from './probe.js';
import { appLogs, controlApp, deleteApp, deployApp } from './ops.js';
import { checkWaha, listSessions } from './waha.js';
import type { FleetCfg, PendingAction, ServerCfg, ServerSnapshot, WahaHealth } from './types.js';

export interface BotDeps {
  db: Db;
  fleet: FleetCfg;
  snapshots: () => ServerSnapshot[];
  refresh: () => Promise<ServerSnapshot[]>;
  readOnly: () => boolean;
  setReadOnly: (value: boolean) => void;
  wahaKey: () => string;
  wahaHealth: () => Map<string, WahaHealth[]>;
  log: (line: string) => void;
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
    const snaps = await deps.refresh();
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
    await ctx.reply(
      [`<b>Estado de la flota</b>`, pre(body), `<b>Incidentes</b>\n${incidentLines}`].join('\n'),
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
      deps.db.addAction({
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

async function runAction(ctx: Context, deps: BotDeps, action: PendingAction): Promise<void> {
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
    deps.db.addAction({
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
    deps.db.addAction({
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
    '/auditoria — últimas acciones',
    '',
    '<b>Acciones</b>',
    '/instalar waha [cantidad] [servidor]',
    '/deploy | /restart | /stop | /delete &lt;wahaNN|uuid&gt;',
    '/modo solo-lectura | /modo normal',
    '',
    `Modo actual: <b>${deps.readOnly() ? 'solo-lectura' : 'normal'}</b>`,
  ].join('\n');
}
