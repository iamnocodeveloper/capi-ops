import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { env, telegramCfg } from './config.js';
import type { BotDeps } from './bot.js';
import { installWaha } from './installer.js';
import type { Db } from './db.js';
import type { StatsSummary } from './pg.js';
import type { FleetCfg, ServerSnapshot } from './types.js';

export interface HttpDeps extends BotDeps {
  startedAt: number;
  lastCycleAt: () => number;
  notify: (text: string) => Promise<void>;
  stats?: (days: number) => Promise<StatsSummary | null>;
}

export function startHttp(deps: HttpDeps): { close: () => void } {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${env.HTTP_PORT}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        const ep = deps.ep?.() ?? null;
        return json(res, 200, {
          ok: true,
          uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
          lastCycleAt: deps.lastCycleAt() ? new Date(deps.lastCycleAt()).toISOString() : null,
          telegram: telegramCfg.enabled,
          readOnly: deps.readOnly(),
          servers: deps.snapshots().map((s) => ({
            alias: s.alias,
            ip: s.ip,
            reachable: s.reachable,
            apps: s.apps.length,
            cpu: s.metrics.cpuPercent,
            mem: s.metrics.memPercent,
            disk: s.metrics.diskPercent,
          })),
          easyPanel: ep
            ? {
                alias: ep.alias,
                url: ep.url,
                ip: ep.ip,
                reachable: ep.reachable,
                cpu: ep.cpuPercent,
                mem: ep.memPercent,
                disk: ep.diskPercent,
                services: ep.services.length,
                down: ep.services.filter((s) => s.state === 'down').length,
                updateAvailable: ep.updateAvailable,
                updateVersion: ep.updateVersion,
              }
            : null,
          openIncidents: deps.db.openIncidents().length,
        });
      }

      if (req.method === 'GET' && url.pathname === '/metrics') {
        const lines: string[] = [];
        for (const s of deps.snapshots()) {
          const labels = `{server="${s.alias}",ip="${s.ip}"}`;
          lines.push(`capi_server_up${labels} ${s.reachable ? 1 : 0}`);
          lines.push(`capi_server_apps${labels} ${s.apps.length}`);
          if (s.metrics.cpuPercent !== null) lines.push(`capi_cpu_percent${labels} ${s.metrics.cpuPercent.toFixed(2)}`);
          if (s.metrics.memPercent !== null) lines.push(`capi_mem_percent${labels} ${s.metrics.memPercent.toFixed(2)}`);
          if (s.metrics.diskPercent !== null) lines.push(`capi_disk_percent${labels} ${s.metrics.diskPercent.toFixed(2)}`);
        }
        const ep = deps.ep?.() ?? null;
        if (ep) {
          const host = `{alias="${ep.alias}"}`;
          lines.push(`capi_easypanel_up${host} ${ep.reachable ? 1 : 0}`);
          if (ep.cpuPercent !== null) lines.push(`capi_easypanel_cpu_percent${host} ${ep.cpuPercent.toFixed(2)}`);
          if (ep.memPercent !== null) lines.push(`capi_easypanel_mem_percent${host} ${ep.memPercent.toFixed(2)}`);
          if (ep.diskPercent !== null) lines.push(`capi_easypanel_disk_percent${host} ${ep.diskPercent.toFixed(2)}`);
          lines.push(`capi_easypanel_update_available${host} ${ep.updateAvailable ? 1 : 0}`);
          for (const svc of ep.services) {
            const labels = `{alias="${ep.alias}",project="${svc.project}",service="${svc.name}"}`;
            lines.push(`capi_easypanel_service_up${labels} ${svc.state === 'up' ? 1 : 0}`);
            lines.push(`capi_easypanel_service_desired${labels} ${svc.desired}`);
            lines.push(`capi_easypanel_service_actual${labels} ${svc.actual}`);
            if (svc.httpOk !== null) lines.push(`capi_easypanel_service_http_ok${labels} ${svc.httpOk ? 1 : 0}`);
          }
        }
        lines.push(`capi_open_incidents ${deps.db.openIncidents().length}`);
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        res.end(`${lines.join('\n')}\n`);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/stats') {
        const days = Number(url.searchParams.get('days') ?? '7');
        if (!deps.stats) return json(res, 503, { ok: false, error: 'histórico no configurado' });
        const summary = await deps.stats(Number.isFinite(days) ? days : 7);
        return json(res, summary ? 200 : 503, summary ?? { ok: false, error: 'histórico no configurado' });
      }

      if (req.method === 'POST' && url.pathname === '/intent') {
        const provided = String(req.headers['x-ops-token'] ?? '');
        if (!env.INTENT_TOKEN || provided !== env.INTENT_TOKEN) {
          return json(res, 401, { ok: false, error: 'token inválido' });
        }
        const body = await readBody(req);
        const result = await handleIntent(body, deps);
        return json(res, result.ok ? 200 : 400, result);
      }

      json(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      json(res, 500, { ok: false, error: (err as Error).message });
    }
  });

  server.listen(env.HTTP_PORT, () => {
    deps.log(`http escuchando en :${env.HTTP_PORT}`);
  });

  return { close: () => server.close() };
}

interface IntentResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

async function handleIntent(body: unknown, deps: HttpDeps): Promise<IntentResult> {
  const payload = (body ?? {}) as { text?: string; command?: string; count?: number; server?: string };
  const text = (payload.text ?? '').toLowerCase();
  const command = payload.command ?? (text.includes('instal') || text.includes('crea') ? 'instalar' : null);

  if (command === 'estado' || text.includes('estado')) {
    const snaps = await deps.refresh();
    return {
      ok: true,
      message: snaps
        .map(
          (s) =>
            `${s.alias} ${s.ip}: ${s.reachable ? 'ok' : 'caído'} · cpu ${fmt(s.metrics.cpuPercent)} · mem ${fmt(s.metrics.memPercent)} · disco ${fmt(s.metrics.diskPercent)} · ${s.apps.length} apps`,
        )
        .join('\n'),
      data: snaps,
    };
  }

  if (command === 'instalar') {
    if (deps.readOnly()) return { ok: false, message: 'modo solo-lectura activo' };
    const countFromText = Number(/(\d+)/.exec(text)?.[1] ?? NaN);
    const count = Math.min(Math.max(payload.count ?? (Number.isFinite(countFromText) ? countFromText : 1), 1), 5);
    const server = payload.server ?? matchServer(text, deps.fleet);
    const snaps = await deps.refresh();
    const outcomes = await installWaha(deps.db, deps.fleet, { count, serverAlias: server, snapshots: snaps });
    await deps.notify(
      outcomes
        .map((o) =>
          o.error
            ? `❌ waha${o.number}: ${o.error}`
            : `✅ waha${o.number} en ${o.alias} (${o.ip}) — ${o.httpOk ? 'HTTP ok' : 'HTTP sin respuesta'}${o.dnsOk ? '' : ' · DNS pendiente'}`,
        )
        .join('\n'),
    );
    return {
      ok: outcomes.every((o) => !o.error),
      message: outcomes
        .map((o) => (o.error ? `waha${o.number}: ${o.error}` : `waha${o.number} en ${o.alias} (${o.ip}) https://${o.domain}`))
        .join('\n'),
      data: outcomes,
    };
  }

  return { ok: false, message: 'intent no reconocido (usá "estado" o "instalar")' };
}

function matchServer(text: string, fleet: FleetCfg): string | undefined {
  const byAlias = fleet.servers.find((s) => text.includes(s.alias));
  if (byAlias) return byAlias.alias;
  const byNumber = /servidor\s*(\d)/.exec(text);
  if (byNumber) {
    const alias = `capi${byNumber[1]}`;
    if (fleet.servers.some((s) => s.alias === alias)) return alias;
  }
  return undefined;
}

function fmt(v: number | null): string {
  return v === null ? '–' : `${v.toFixed(0)}%`;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
