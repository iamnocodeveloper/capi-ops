import { clientFor } from './mcp.js';
import { wahaApiKey } from './config.js';
import type { Db } from './db.js';
import { isWaha, probeServer } from './probe.js';
import { checkWaha } from './waha.js';
import type { AppInfo, FleetCfg, ServerCfg, ServerSnapshot } from './types.js';

export interface InstallOutcome {
  number: number;
  alias: string;
  ip: string;
  domain: string;
  appUuid: string | null;
  deployStatus: string | null;
  httpOk: boolean;
  dnsOk: boolean;
  engine: string | null;
  error: string | null;
}

export interface InstallOptions {
  count: number;
  serverAlias?: string;
  snapshots: ServerSnapshot[];
  onProgress?: (line: string) => void;
}

const DEPLOY_POLL_MS = 5000;
const DEPLOY_TIMEOUT_MS = 5 * 60_000;
const VERIFY_TRIES = 10;

export function nextWahaNumber(db: Db, snapshots: ServerSnapshot[]): number {
  const numbers: number[] = [];
  const fromDb = db.getLastWahaNumber();
  if (fromDb > 0) numbers.push(fromDb);
  for (const row of db.inventory()) {
    const m = /^waha(\d+)$/i.exec(row.name);
    if (m) numbers.push(Number(m[1]));
  }
  for (const snap of snapshots) {
    for (const app of snap.apps) if (app.number !== null) numbers.push(app.number);
  }
  const max = numbers.length ? Math.max(...numbers) : 0;
  return max + 1;
}

export interface ServerPick {
  server: ServerCfg;
  snapshot: ServerSnapshot;
  score: number;
  reason: string;
}

export function pickServer(fleet: FleetCfg, snapshots: ServerSnapshot[]): ServerPick | null {
  const candidates: ServerPick[] = [];
  for (const server of fleet.servers) {
    const snapshot = snapshots.find((s) => s.alias === server.alias);
    if (!snapshot) continue;
    if (!snapshot.reachable) continue;
    const mem = snapshot.metrics.memPercent ?? 0;
    const disk = snapshot.metrics.diskPercent ?? 0;
    if (mem > 85 || disk > 85) continue;
    const score = Math.max(mem, disk) + snapshot.apps.length * 0.2;
    candidates.push({
      server,
      snapshot,
      score,
      reason: `mem ${mem.toFixed(0)}% · disco ${disk.toFixed(0)}% · ${snapshot.apps.length} apps`,
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0] ?? null;
}

function envPayload(fleet: FleetCfg): unknown[] {
  const key = wahaApiKey();
  const w = fleet.waha;
  return [
    { key: 'WAHA_API_KEY', value: key },
    { key: 'WAHA_DASHBOARD_USERNAME', value: w.dashboardUser },
    { key: 'WAHA_DASHBOARD_PASSWORD', value: key },
    { key: 'WHATSAPP_SWAGGER_USERNAME', value: w.dashboardUser },
    { key: 'WHATSAPP_SWAGGER_PASSWORD', value: key },
    { key: 'WHATSAPP_DEFAULT_ENGINE', value: w.engine },
  ].map((v) => ({ ...v, is_runtime: true, is_buildtime: true, is_preview: false }));
}

async function waitDeployment(server: ServerCfg, deploymentUuid: string, onProgress?: (l: string) => void): Promise<string> {
  const client = clientFor(server);
  const started = Date.now();
  let lastStatus = 'queued';
  while (Date.now() - started < DEPLOY_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, DEPLOY_POLL_MS));
    const res = await client.tryTool<{ data?: { status?: string } | Array<{ status?: string }> }>('get_deployment', {
      uuid: deploymentUuid,
    });
    const data = res?.data;
    const status = Array.isArray(data) ? data[0]?.status : data?.status;
    if (status && status !== lastStatus) {
      lastStatus = status;
      onProgress?.(`  deploy ${deploymentUuid.slice(0, 8)}: ${status}`);
    }
    if (status === 'finished' || status === 'failed' || status === 'cancelled') return status;
  }
  return `timeout (${lastStatus})`;
}

export async function installWaha(
  db: Db,
  fleet: FleetCfg,
  opts: InstallOptions,
): Promise<InstallOutcome[]> {
  const outcomes: InstallOutcome[] = [];
  let number = nextWahaNumber(db, opts.snapshots);

  for (let i = 0; i < opts.count; i++) {
    let server: ServerCfg | undefined;
    if (opts.serverAlias) {
      server = fleet.servers.find((s) => s.alias === opts.serverAlias);
      if (!server) {
        outcomes.push({
          number,
          alias: opts.serverAlias,
          ip: '',
          domain: '',
          appUuid: null,
          deployStatus: null,
          httpOk: false,
          dnsOk: false,
          engine: null,
          error: `servidor desconocido: ${opts.serverAlias}`,
        });
        break;
      }
    } else {
      const pick = pickServer(fleet, opts.snapshots);
      if (!pick) {
        outcomes.push({
          number,
          alias: '',
          ip: '',
          domain: '',
          appUuid: null,
          deployStatus: null,
          httpOk: false,
          dnsOk: false,
          engine: null,
          error: 'no hay servidor con capacidad (mem/disco > 85% o caído)',
        });
        break;
      }
      server = pick.server;
      opts.onProgress?.(`servidor elegido: ${server.name} (${pick.reason})`);
    }

    const name = `waha${number}`;
    const domain = `${name}.${fleet.domainBase}`;
    opts.onProgress?.(`creando ${name} en ${server.name}…`);

    const outcome = await installOne(db, fleet, server, number, name, domain, opts.onProgress);
    outcomes.push(outcome);

    if (outcome.appUuid) db.setLastWahaNumber(number);
    number++;
  }

  return outcomes;
}

async function installOne(
  db: Db,
  fleet: FleetCfg,
  server: ServerCfg,
  number: number,
  name: string,
  domain: string,
  onProgress?: (l: string) => void,
): Promise<InstallOutcome> {
  const client = clientFor(server);
  const base: InstallOutcome = {
    number,
    alias: server.alias,
    ip: server.ip,
    domain,
    appUuid: null,
    deployStatus: null,
    httpOk: false,
    dnsOk: false,
    engine: null,
    error: null,
  };

  try {
    const created = await client.tool<{ data?: { uuid?: string } }>('create_application', {
      action: 'docker_image',
      data: {
        project_uuid: server.projectUuid,
        environment_name: server.environmentName,
        server_uuid: server.serverUuid,
        destination_uuid: server.destinationUuid,
        name,
        docker_registry_image_name: fleet.waha.imageName,
        docker_registry_image_tag: fleet.waha.imageTag,
        ports_exposes: fleet.waha.portsExposes,
        domains: `https://${domain},https://www.${domain}`,
      },
    });
    const appUuid = created?.data?.uuid ?? null;
    if (!appUuid) throw new Error('create_application no devolvió uuid');
    base.appUuid = appUuid;
    onProgress?.(`  app ${appUuid}`);

    await client.tool('manage_env', {
      action: 'bulk_update',
      resource: 'application',
      uuid: appUuid,
      data: { data: envPayload(fleet) },
    });
    onProgress?.('  variables cargadas');

    const deployed = await client.tool<{ data?: { deployment_uuid?: string } }>('deploy', {
      uuid: appUuid,
    });
    const deploymentUuid = deployed?.data?.deployment_uuid;
    if (!deploymentUuid) throw new Error('deploy no devolvió deployment_uuid');

    base.deployStatus = await waitDeployment(server, deploymentUuid, onProgress);

    const key = wahaApiKey();
    for (let attempt = 0; attempt < VERIFY_TRIES; attempt++) {
      const health = await checkWaha(name, domain, server.ip, key);
      if (health.httpOk) {
        base.httpOk = true;
        base.dnsOk = health.dnsOk;
        base.engine = health.engine;
        break;
      }
      base.dnsOk = health.dnsOk;
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (!base.httpOk) {
      base.dnsOk = (await checkWaha(name, domain, server.ip, wahaApiKey())).dnsOk;
    }

    const appsAfter = await client.tryTool<{ data?: unknown[] }>('list_applications', { per_page: 100 });
    const inventory = (appsAfter?.data ?? []) as Array<{ uuid?: string; name?: string; fqdn?: string }>;
    db.replaceInventory(
      server.alias,
      inventory
        .filter((a) => typeof a.uuid === 'string')
        .map((a) => ({ uuid: a.uuid as string, name: a.name ?? '', fqdn: a.fqdn ?? '' })),
    );
  } catch (err) {
    base.error = (err as Error).message;
    onProgress?.(`  error: ${base.error}`);
  }

  return base;
}

export async function refreshInventory(db: Db, snapshots: ServerSnapshot[]): Promise<void> {
  for (const snap of snapshots) {
    db.replaceInventory(
      snap.alias,
      snap.apps.map((a) => ({ uuid: a.uuid, name: a.name, fqdn: a.fqdn })),
    );
  }
}

export async function snapshotFleet(fleet: FleetCfg): Promise<ServerSnapshot[]> {
  const out: ServerSnapshot[] = [];
  for (const server of fleet.servers) {
    out.push(await probeServer(server));
  }
  return out;
}

export function findApp(
  snapshots: ServerSnapshot[],
  query: string,
): { server: ServerSnapshot; app: AppInfo } | null {
  const q = query.trim().toLowerCase();
  for (const snap of snapshots) {
    for (const app of snap.apps) {
      if (!isWaha(app) && !app.name) continue;
      if (app.name.toLowerCase() === q || app.uuid === q) return { server: snap, app };
      if (app.number !== null && (q === `waha${app.number}` || q === String(app.number))) {
        return { server: snap, app };
      }
    }
  }
  return null;
}
