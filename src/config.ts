import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { EasyPanelCfg, FleetCfg, ServerCfg } from './types.js';

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(resolve(process.cwd(), '.env'));

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const n = Number(v);
      return v === undefined || v === '' || Number.isNaN(n) ? def : n;
    });

const EnvSchema = z.object({
  TG_TOKEN: z.string().optional().default(''),
  TG_ALLOWED_CHATS: z.string().optional().default(''),
  TG_ALLOWED_USERS: z.string().optional().default(''),
  TG_ADMIN_CHAT: z.string().optional().default(''),
  WAHA_API_KEY: z.string().optional().default(''),
  EASYPANEL_URL: z.string().optional().default(''),
  EASYPANEL_TOKEN: z.string().optional().default(''),
  EASYPANEL_ALIAS: z.string().optional().default('ep'),
  EASYPANEL_NAME: z.string().optional().default('EasyPanel'),
  EASYPANEL_IP: z.string().optional().default(''),
  EASYPANEL_HTTP: bool(true),
  EP_SERVICE_CPU: num(90),
  OPS_READ_ONLY: bool(false),
  POLL_SECONDS: num(60),
  WAHA_PROBE_SECONDS: num(300),
  TH_CPU: num(85),
  TH_MEM: num(90),
  TH_DISK_WARN: num(80),
  TH_DISK_CRIT: num(90),
  RENOTIFY_MINUTES: num(360),
  QUIET_HOURS: z.string().optional().default(''),
  DIGEST_AT: z.string().optional().default('09:00'),
  HEARTBEAT_URL: z.string().optional().default(''),
  HTTP_PORT: num(8080),
  DATA_DIR: z.string().optional().default('./data'),
  SERVERS_FILE: z.string().optional().default('./config/servers.json'),
  INTENT_TOKEN: z.string().optional().default(''),
  LOG_LEVEL: z.string().optional().default('info'),
});

export const env = EnvSchema.parse(process.env);

const ServerSchema = z.object({
  alias: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
  tokenEnv: z.string().min(1),
  token: z.string().optional(),
  ip: z.string().min(1),
  projectUuid: z.string().min(1),
  environmentName: z.string().default('production'),
  serverUuid: z.string().min(1),
  destinationUuid: z.string().min(1),
  wahaRange: z.tuple([z.number(), z.number()]),
});

const FleetSchema = z.object({
  domainBase: z.string().min(1),
  waha: z.object({
    imageName: z.string().default('devlikeapro/waha'),
    imageTag: z.string().default('latest'),
    portsExposes: z.string().default('80'),
    apiKeyEnv: z.string().default('WAHA_API_KEY'),
    engine: z.string().default('GOWS'),
    dashboardUser: z.string().default('admin'),
  }),
  servers: z.array(ServerSchema).min(1),
});

function parseFleet(raw: unknown): FleetCfg {
  const parsed = FleetSchema.parse(raw);
  const servers: ServerCfg[] = parsed.servers.map((s) => ({
    ...s,
    token: s.token ?? process.env[s.tokenEnv] ?? '',
  }));
  return { ...parsed, servers };
}

/**
 * Carga la flota. Prioriza `SERVERS_JSON` (JSON inline en el entorno, sin infraestructura en el
 * repo); si no está, lee el archivo indicado por `SERVERS_FILE`.
 */
export function loadFleet(path = env.SERVERS_FILE): FleetCfg {
  const inline = process.env.SERVERS_JSON?.trim();
  if (inline) {
    let raw: unknown;
    try {
      raw = JSON.parse(inline);
    } catch (err) {
      throw new Error(`SERVERS_JSON no es JSON válido: ${(err as Error).message}`);
    }
    return parseFleet(raw);
  }

  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) {
    throw new Error(
      `No hay flota configurada: definí SERVERS_JSON o apuntá SERVERS_FILE a un archivo existente (${abs})`,
    );
  }
  return parseFleet(JSON.parse(readFileSync(abs, 'utf8')));
}

export function tokenOf(s: ServerCfg): string {
  const token = s.token ?? process.env[s.tokenEnv] ?? '';
  if (!token) {
    throw new Error(
      `Falta el token del servidor ${s.alias}: definí la variable ${s.tokenEnv} en el entorno`,
    );
  }
  return token;
}

export function wahaApiKey(): string {
  const key = process.env.WAHA_API_KEY ?? '';
  if (!key) throw new Error('Falta WAHA_API_KEY en el entorno');
  return key;
}

/**
 * EasyPanel self-hosting opcional. Se activa solo si están `EASYPANEL_URL` y `EASYPANEL_TOKEN`;
 * sin ellos el resto del watcher funciona igual.
 */
export function easyPanelCfg(): EasyPanelCfg | null {
  const url = env.EASYPANEL_URL.trim().replace(/\/+$/, '');
  const token = env.EASYPANEL_TOKEN.trim();
  if (!url || !token) return null;
  let host = env.EASYPANEL_IP.trim();
  if (!host) {
    try {
      host = new URL(url).hostname;
    } catch {
      throw new Error(`EASYPANEL_URL no es una URL válida: ${url}`);
    }
  }
  return {
    alias: env.EASYPANEL_ALIAS || 'ep',
    name: env.EASYPANEL_NAME || 'EasyPanel',
    url,
    token,
    ip: host,
    httpProbe: env.EASYPANEL_HTTP,
  };
}

export const paths = {
  data: resolve(process.cwd(), env.DATA_DIR),
  db: resolve(process.cwd(), env.DATA_DIR, 'state.sqlite'),
};

export const telegramCfg = {
  token: env.TG_TOKEN,
  allowedChats: env.TG_ALLOWED_CHATS.split(',').map((s) => Number(s.trim())).filter((n) => n !== 0),
  allowedUsers: env.TG_ALLOWED_USERS.split(',').map((s) => Number(s.trim())).filter((n) => n !== 0),
  adminChat: Number(env.TG_ADMIN_CHAT) || 0,
  enabled: env.TG_TOKEN.length > 0,
};

export const thresholds = {
  cpu: env.TH_CPU,
  mem: env.TH_MEM,
  diskWarn: env.TH_DISK_WARN,
  diskCrit: env.TH_DISK_CRIT,
  epServiceCpu: env.EP_SERVICE_CPU,
  renotifyMs: env.RENOTIFY_MINUTES * 60_000,
};
