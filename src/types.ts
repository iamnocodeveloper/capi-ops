export type Severity = 'info' | 'media' | 'alta' | 'critica';

export interface WahaSettings {
  imageName: string;
  imageTag: string;
  portsExposes: string;
  apiKeyEnv: string;
  engine: string;
  dashboardUser: string;
}

export interface ServerCfg {
  alias: string;
  name: string;
  url: string;
  tokenEnv: string;
  token?: string;
  ip: string;
  projectUuid: string;
  environmentName: string;
  serverUuid: string;
  destinationUuid: string;
  wahaRange: [number, number];
}

export interface FleetCfg {
  domainBase: string;
  waha: WahaSettings;
  servers: ServerCfg[];
}

export interface AppInfo {
  uuid: string;
  name: string;
  fqdn: string;
  status: string;
  domain: string;
  number: number | null;
}

export interface ServerMetrics {
  online: boolean;
  cpuPercent: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  memPercent: number | null;
  diskPercent: number | null;
  load1: number | null;
  netRx: number | null;
  netTx: number | null;
}

export interface WahaHealth {
  name: string;
  domain: string;
  httpOk: boolean;
  version: string | null;
  engine: string | null;
  dnsOk: boolean;
  resolved: string[];
  error: string | null;
}

export interface ServerSnapshot {
  alias: string;
  name: string;
  ip: string;
  reachable: boolean;
  metrics: ServerMetrics;
  apps: AppInfo[];
  unhealthy: string[];
  openDeployments: number;
  lastError: string | null;
  collectedAt: number;
}

export interface EasyPanelCfg {
  alias: string;
  name: string;
  url: string;
  token: string;
  ip: string;
  httpProbe: boolean;
}

export type EpServiceState = 'up' | 'down' | 'off' | 'unknown';

export interface EpService {
  project: string;
  name: string;
  key: string;
  type: string;
  host: string | null;
  url: string | null;
  enabled: boolean;
  desired: number;
  actual: number;
  state: EpServiceState;
  cpuPercent: number | null;
  memBytes: number | null;
  httpOk: boolean | null;
  httpStatus: number | null;
  httpMs: number | null;
  httpError: string | null;
}

export interface EpSnapshot {
  alias: string;
  name: string;
  url: string;
  ip: string;
  reachable: boolean;
  cpuPercent: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  memPercent: number | null;
  diskPercent: number | null;
  diskUsedGb: number | null;
  diskTotalGb: number | null;
  load1: number | null;
  cores: number | null;
  uptimeSeconds: number | null;
  updateAvailable: boolean;
  updateVersion: string | null;
  services: EpService[];
  lastError: string | null;
  collectedAt: number;
}

export interface PendingAction {
  id: string;
  chatId: number;
  userId: number;
  command: string;
  args: Record<string, unknown>;
  description: string;
  createdAt: number;
  stage: 'confirm' | 'typed';
}

export interface IncidentRow {
  id: number;
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  opened_at: number;
  last_notified_at: number;
  resolved_at: number | null;
}
