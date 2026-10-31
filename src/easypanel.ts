import type {
  EasyPanelCfg,
  EpService,
  EpServiceState,
  EpSnapshot,
  ServerSnapshot,
} from './types.js';
import { mapLimit } from './waha.js';

const API_TIMEOUT_MS = 20_000;
const HTTP_TIMEOUT_MS = 8_000;
const HTTP_CONCURRENCY = 8;

interface SystemStats {
  cpuInfo?: { count?: number; loadavg?: number[]; usedPercentage?: number };
  diskInfo?: {
    totalGb?: string;
    usedGb?: string;
    freeGb?: string;
    usedPercentage?: string;
    freePercentage?: string;
  };
  memInfo?: {
    totalMemMb?: number;
    usedMemMb?: number;
    freeMemMb?: number;
    usedMemPercentage?: number;
    freeMemPercentage?: number;
  };
  network?: { inputMb?: number; outputMb?: number };
  uptime?: number;
}

interface TaskStats {
  [key: string]: { actual?: number; desired?: number };
}

interface MonitorRow {
  containerName?: string;
  projectName?: string;
  serviceName?: string;
  stats?: {
    cpu?: { percent?: number };
    memory?: { percent?: number; usage?: number };
    network?: { in?: number; out?: number };
  };
}

interface ProjectService {
  name: string;
  type?: string;
  enabled?: boolean;
  projectName?: string;
  primaryDomainId?: string | null;
}

interface ProjectsResponse {
  projects?: Array<{ name: string }>;
  services?: ProjectService[];
}

interface DomainRow {
  id?: string;
  https?: boolean;
  host?: string;
  path?: string;
  wildcard?: boolean;
  serviceDestination?: { projectName?: string; serviceName?: string; path?: string; port?: number };
}

interface UpdateStatus {
  available?: boolean;
  releaseTag?: string;
  version?: string;
}

export type EpAction = 'deploy' | 'restart' | 'stop' | 'start';

/** Cliente mínimo de la API REST de EasyPanel (`/api/<procedimiento>` + Bearer). */
class EasyPanelApi {
  private readonly base: string;

  constructor(private readonly cfg: EasyPanelCfg) {
    this.base = `${cfg.url.replace(/\/+$/, '')}/api`;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    procedure: string,
    query?: Record<string, string | number>,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(`${this.base}/${procedure}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, String(value));
    }
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} en ${procedure}: ${text.slice(0, 200)}`);
    }
    if (!text.trim()) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  get<T>(procedure: string, query?: Record<string, string | number>): Promise<T> {
    return this.request<T>('GET', procedure, query);
  }

  post<T>(procedure: string, body: Record<string, unknown> = {}): Promise<T> {
    return this.request<T>('POST', procedure, undefined, body);
  }
}

function emptySnapshot(cfg: EasyPanelCfg): EpSnapshot {
  return {
    alias: cfg.alias,
    name: cfg.name,
    url: cfg.url,
    ip: cfg.ip,
    reachable: false,
    cpuPercent: null,
    memUsedBytes: null,
    memTotalBytes: null,
    memPercent: null,
    diskPercent: null,
    diskUsedGb: null,
    diskTotalGb: null,
    load1: null,
    cores: null,
    uptimeSeconds: null,
    updateAvailable: false,
    updateVersion: null,
    services: [],
    lastError: null,
    collectedAt: Date.now(),
  };
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function serviceKey(project: string, name: string): string {
  return `${project}_${name}`;
}

function domainKey(project: string | undefined, name: string | undefined): string | null {
  return project && name ? `${project}/${name}` : null;
}

function pickDomain(rows: DomainRow[], service: ProjectService): DomainRow | null {
  const candidates = rows.filter((d) => d.host && !d.wildcard);
  if (!candidates.length) return null;
  if (service.primaryDomainId) {
    const primary = candidates.find((d) => d.id === service.primaryDomainId);
    if (primary) return primary;
  }
  return candidates[0] ?? null;
}

function serviceUrl(domain: DomainRow): string | null {
  if (!domain.host) return null;
  const scheme = domain.https ? 'https' : 'http';
  const path = domain.path && domain.path !== '/' ? `/${domain.path.replace(/^\/+/, '')}` : '/';
  return `${scheme}://${domain.host}${path}`;
}

interface HttpResult {
  ok: boolean;
  status: number | null;
  ms: number;
  error: string | null;
}

async function probeHttp(url: string): Promise<HttpResult> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { 'user-agent': 'capi-ops/0.5 (+easypanel)' },
    });
    try {
      await res.body?.cancel();
    } catch {
      // el cuerpo no se consume: alcanza con el status
    }
    const ms = Date.now() - started;
    const ok = res.status < 500;
    return { ok, status: res.status, ms, error: ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: null, ms: Date.now() - started, error: (err as Error).message };
  }
}

function stateOf(desired: number, actual: number): EpServiceState {
  if (desired === 0) return 'off';
  return actual >= desired ? 'up' : 'down';
}

export interface EpProbeOptions {
  log?: (line: string) => void;
}

/** Recolecta el estado del host y sus servicios desde la API de EasyPanel. */
export async function probeEasyPanel(
  cfg: EasyPanelCfg,
  opts: EpProbeOptions = {},
): Promise<EpSnapshot> {
  const api = new EasyPanelApi(cfg);
  const base = emptySnapshot(cfg);

  try {
    const [system, tasks, monitor, projects, update] = await Promise.all([
      api.get<SystemStats>('getLegacyMonitorSystemStats'),
      api.get<TaskStats>('getDockerTaskStats').catch((): TaskStats => ({})),
      api.get<MonitorRow[]>('getMonitorTableData').catch(() => []),
      api.get<ProjectsResponse>('listProjectsAndServices'),
      api.get<UpdateStatus>('getUpdateStatus').catch(() => null),
    ]);

    const projectNames = [
      ...new Set(
        [
          ...(projects.projects ?? []).map((p) => p.name),
          ...(projects.services ?? []).map((s) => s.projectName),
        ].filter((name): name is string => typeof name === 'string' && name.length > 0),
      ),
    ];

    const domainRows = (
      await Promise.all(
        projectNames.map((projectName) =>
          api.get<DomainRow[]>('listDomains', { projectName }).catch(() => [] as DomainRow[]),
        ),
      )
    ).flat();

    const uniqueDomains = [
      ...new Map(domainRows.map((row) => [row.id ?? `${row.host}${row.path ?? ''}`, row])).values(),
    ];

    const domainsByService = new Map<string, DomainRow[]>();
    for (const row of uniqueDomains) {
      const key = domainKey(row.serviceDestination?.projectName, row.serviceDestination?.serviceName);
      if (!key) continue;
      const list = domainsByService.get(key) ?? [];
      list.push(row);
      domainsByService.set(key, list);
    }

    const statsByService = new Map<string, { cpu: number; mem: number }>();
    for (const row of Array.isArray(monitor) ? monitor : []) {
      if (!row.projectName || !row.serviceName) continue;
      const key = serviceKey(row.projectName, row.serviceName);
      const current = statsByService.get(key) ?? { cpu: 0, mem: 0 };
      current.cpu += num(row.stats?.cpu?.percent) ?? 0;
      current.mem += num(row.stats?.memory?.usage) ?? 0;
      statsByService.set(key, current);
    }

    const services: EpService[] = (projects.services ?? []).map((item) => {
      const project = item.projectName ?? '';
      const key = serviceKey(project, item.name);
      const task = tasks[key];
      const stats = statsByService.get(key);
      // Los stacks Compose no siempre aparecen en getDockerTaskStats: si hay métricas de
      // contenedores, el servicio está corriendo.
      let desired = 0;
      let actual = 0;
      let known = false;
      if (task) {
        desired = num(task.desired) ?? 0;
        actual = num(task.actual) ?? 0;
        known = true;
      } else if (stats) {
        desired = 1;
        actual = 1;
        known = true;
      } else if (item.enabled === false) {
        known = true;
      }
      const domain = pickDomain(domainsByService.get(`${project}/${item.name}`) ?? [], item);
      const url = domain ? serviceUrl(domain) : null;

      return {
        project,
        name: item.name,
        key,
        type: item.type ?? 'unknown',
        host: domain?.host ?? null,
        url,
        enabled: item.enabled !== false,
        desired,
        actual,
        state: known ? stateOf(desired, actual) : 'unknown',
        cpuPercent: stats ? stats.cpu : null,
        memBytes: stats ? stats.mem : null,
        httpOk: null,
        httpStatus: null,
        httpMs: null,
        httpError: null,
      };
    });

    if (cfg.httpProbe) {
      const targets = services.filter((s) => s.url && (s.state === 'up' || s.state === 'unknown'));
      const results = await mapLimit(targets, HTTP_CONCURRENCY, async (service) => {
        const result = await probeHttp(service.url as string);
        service.httpOk = result.ok;
        service.httpStatus = result.status;
        service.httpMs = result.ms;
        service.httpError = result.error;
        return service;
      });
      opts.log?.(`easypanel http: ${results.length} dominios en ${cfg.alias}`);
    }

    const cpu = num(system.cpuInfo?.usedPercentage);
    const memTotalMb = num(system.memInfo?.totalMemMb);
    const memUsedMb = num(system.memInfo?.usedMemMb);
    const load = Array.isArray(system.cpuInfo?.loadavg) ? num(system.cpuInfo.loadavg[0]) : null;

    return {
      ...base,
      reachable: true,
      cpuPercent: cpu,
      memUsedBytes: memUsedMb === null ? null : memUsedMb * 1024 * 1024,
      memTotalBytes: memTotalMb === null ? null : memTotalMb * 1024 * 1024,
      memPercent: num(system.memInfo?.usedMemPercentage),
      diskPercent: num(system.diskInfo?.usedPercentage),
      diskUsedGb: num(system.diskInfo?.usedGb),
      diskTotalGb: num(system.diskInfo?.totalGb),
      load1: load,
      cores: num(system.cpuInfo?.count),
      uptimeSeconds: num(system.uptime),
      updateAvailable: update?.available === true,
      updateVersion: update?.version ?? null,
      services: services.sort((a, b) =>
        a.project === b.project ? a.name.localeCompare(b.name) : a.project.localeCompare(b.project),
      ),
      lastError: null,
      collectedAt: Date.now(),
    };
  } catch (err) {
    return {
      ...base,
      reachable: false,
      lastError: (err as Error).message,
      collectedAt: Date.now(),
    };
  }
}

const ACTION_ENDPOINTS: Record<string, Record<EpAction, string | null>> = {
  app: {
    deploy: 'deployAppService',
    restart: 'restartAppService',
    stop: 'stopAppService',
    start: 'startAppService',
  },
  compose: {
    deploy: 'deployComposeService',
    restart: 'restartComposeService',
    stop: 'stopComposeService',
    start: 'startComposeService',
  },
};

export async function epAction(
  cfg: EasyPanelCfg,
  target: { project: string; service: string; type: string },
  action: EpAction,
): Promise<string> {
  const endpoints = ACTION_ENDPOINTS[target.type];
  const endpoint = endpoints?.[action];
  if (!endpoint) {
    throw new Error(`acción ${action} no soportada para servicios de tipo ${target.type}`);
  }
  const api = new EasyPanelApi(cfg);
  const body: Record<string, unknown> = {
    projectName: target.project,
    serviceName: target.service,
  };
  if (action === 'deploy') body['forceRebuild'] = false;
  await api.post(endpoint, body);
  return `${action} encolado en ${target.project}/${target.service}`;
}

/** Acepta `proyecto/servicio`, `proyecto_servicio`, `servicio` o parte del nombre. */
export function findEpService(ep: EpSnapshot, raw: string): EpService | null {
  const input = raw.trim().toLowerCase();
  if (!input) return null;
  const normalized = input.replace('/', '_');
  const exact = ep.services.find(
    (s) => s.key.toLowerCase() === normalized || s.name.toLowerCase() === input,
  );
  if (exact) return exact;
  const withProject = ep.services.find((s) => `${s.project}/${s.name}`.toLowerCase() === input);
  if (withProject) return withProject;
  return ep.services.find((s) => s.name.toLowerCase().includes(input)) ?? null;
}

export function epStateLabel(service: EpService): string {
  switch (service.state) {
    case 'up':
      return service.httpOk === false ? 'sin http' : 'up';
    case 'down':
      return 'CAÍDO';
    case 'off':
      return 'off';
    default:
      return '?';
  }
}

export function epCounts(ep: EpSnapshot): { up: number; down: number; off: number; unknown: number } {
  const counts = { up: 0, down: 0, off: 0, unknown: 0 };
  for (const service of ep.services) counts[service.state] += 1;
  return counts;
}

/** Adapta el snapshot al modelo de la flota para reutilizar histórico y /stats. */
export function epAsServerSnapshot(ep: EpSnapshot): ServerSnapshot {
  return {
    alias: ep.alias,
    name: ep.name,
    ip: ep.ip,
    reachable: ep.reachable,
    metrics: {
      online: ep.reachable,
      cpuPercent: ep.cpuPercent,
      memUsedBytes: ep.memUsedBytes,
      memTotalBytes: ep.memTotalBytes,
      memPercent: ep.memPercent,
      diskPercent: ep.diskPercent,
      load1: ep.load1,
      netRx: null,
      netTx: null,
    },
    apps: ep.services.map((service) => ({
      uuid: service.key,
      name: service.name,
      fqdn: service.host ?? '',
      status: service.state === 'up' ? 'running' : service.state,
      domain: service.host ?? '',
      number: null,
    })),
    unhealthy: ep.services.filter((s) => s.state === 'down').map((s) => `${s.project}/${s.name}`),
    openDeployments: 0,
    lastError: ep.lastError,
    collectedAt: ep.collectedAt,
  };
}
