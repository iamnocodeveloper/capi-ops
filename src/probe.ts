import { clientFor } from './mcp.js';
import type { AppInfo, ServerCfg, ServerMetrics, ServerSnapshot } from './types.js';

function firstDomain(fqdn: string | null | undefined): string {
  if (!fqdn) return '';
  const first = fqdn.split(',')[0]?.trim() ?? '';
  return first.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

function numberFromDomain(domain: string): number | null {
  const m = /^waha(\d+)\./i.exec(domain);
  return m ? Number(m[1]) : null;
}

function numOrNull(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

interface MetricsResponse {
  data?: {
    online?: boolean;
    current?: {
      cpu_percent?: number | null;
      memory_used_bytes?: number | null;
      memory_total_bytes?: number | null;
      disk_used_percent?: number | null;
      load1?: number | null;
      network_rx_bytes_per_sec?: number | null;
      network_tx_bytes_per_sec?: number | null;
    } | null;
  };
}

interface AppsResponse {
  data?: Array<{ uuid?: string; name?: string; fqdn?: string | null; status?: string }>;
}

interface DeploymentsResponse {
  data?: Array<{ status?: string }>;
}

function emptyMetrics(): ServerMetrics {
  return {
    online: false,
    cpuPercent: null,
    memUsedBytes: null,
    memTotalBytes: null,
    memPercent: null,
    diskPercent: null,
    load1: null,
    netRx: null,
    netTx: null,
  };
}

export function parseApps(raw: AppsResponse | null): AppInfo[] {
  const list = raw?.data ?? [];
  const apps: AppInfo[] = [];
  for (const item of list) {
    if (!item?.uuid) continue;
    const domain = firstDomain(item.fqdn);
    apps.push({
      uuid: item.uuid,
      name: item.name ?? item.uuid,
      fqdn: item.fqdn ?? '',
      status: item.status ?? 'unknown',
      domain,
      number: numberFromDomain(domain),
    });
  }
  return apps;
}

export async function probeServer(server: ServerCfg): Promise<ServerSnapshot> {
  const client = clientFor(server);
  const errors: string[] = [];

  const metricsRaw = await client.tryTool<MetricsResponse>('get_server_metrics', {
    server_uuid: server.serverUuid,
    minutes: 15,
  });
  if (metricsRaw === null) errors.push('metrics');

  const appsRaw = await client.tryTool<AppsResponse>('list_applications', { per_page: 100 });
  if (appsRaw === null) errors.push('apps');

  const deploymentsRaw = await client.tryTool<DeploymentsResponse>('list_deployments', {
    status: 'all',
    per_page: 50,
  });
  if (deploymentsRaw === null) errors.push('deployments');

  const unhealthyRaw = await client.tryTool<unknown>('list_unhealthy_resources', {
    sample_only: true,
  });
  if (unhealthyRaw === null) errors.push('unhealthy');

  const reachable = appsRaw !== null;
  const current = metricsRaw?.data?.current ?? null;

  const metrics: ServerMetrics = current
    ? {
        online: metricsRaw?.data?.online ?? true,
        cpuPercent: numOrNull(current.cpu_percent),
        memUsedBytes: numOrNull(current.memory_used_bytes),
        memTotalBytes: numOrNull(current.memory_total_bytes),
        memPercent:
          numOrNull(current.memory_used_bytes) !== null && numOrNull(current.memory_total_bytes)
            ? ((numOrNull(current.memory_used_bytes) as number) /
                (numOrNull(current.memory_total_bytes) as number)) *
              100
            : null,
        diskPercent: numOrNull(current.disk_used_percent),
        load1: numOrNull(current.load1),
        netRx: numOrNull(current.network_rx_bytes_per_sec),
        netTx: numOrNull(current.network_tx_bytes_per_sec),
      }
    : emptyMetrics();

  const openDeployments = (deploymentsRaw?.data ?? []).filter(
    (d) => d?.status === 'in_progress' || d?.status === 'queued',
  ).length;

  return {
    alias: server.alias,
    name: server.name,
    ip: server.ip,
    reachable,
    metrics,
    apps: parseApps(appsRaw),
    unhealthy: summarizeUnhealthy(unhealthyRaw),
    openDeployments,
    lastError: errors.length ? `sin respuesta: ${errors.join(', ')}` : null,
    collectedAt: Date.now(),
  };
}

/** El shape de list_unhealthy_resources varía; extraemos nombres si están. */
function summarizeUnhealthy(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const data = (raw as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return [];
  const out: string[] = [];
  const walk = (node: unknown, depth = 0): void => {
    if (depth > 4 || !node) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (typeof item === 'string') out.push(item);
        else if (item && typeof item === 'object') {
          const rec = item as Record<string, unknown>;
          const label = rec['name'] ?? rec['application_name'] ?? rec['resource_name'] ?? rec['uuid'];
          if (typeof label === 'string') out.push(label);
          else walk(item, depth + 1);
        }
      }
      return;
    }
    if (typeof node === 'object') {
      for (const value of Object.values(node as Record<string, unknown>)) {
        if (Array.isArray(value)) walk(value, depth + 1);
      }
    }
  };
  walk(data);
  return [...new Set(out)].slice(0, 30);
}

export function fleetApps(snapshots: ServerSnapshot[]): Array<{ app: AppInfo; server: ServerSnapshot }> {
  const out: Array<{ app: AppInfo; server: ServerSnapshot }> = [];
  for (const snap of snapshots) {
    for (const app of snap.apps) out.push({ app, server: snap });
  }
  return out;
}

export function isWaha(app: AppInfo): boolean {
  return app.number !== null && app.domain.length > 0;
}
