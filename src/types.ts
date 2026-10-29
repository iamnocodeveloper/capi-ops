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
