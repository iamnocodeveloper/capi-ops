import { Client, type ConnectConfig } from 'ssh2';
import type { ServerCfg } from './types.js';

/**
 * Alta de servidores nuevos.
 *
 * Dos caminos, ambos desde el bot:
 *  - VPS virgen: se instala Coolify por SSH y se hace el onboarding (habilitar MCP/API,
 *    acuñar un token de equipo y descubrir los UUID) para registrarlo en la flota.
 *  - Coolify ya instalado: solo se descubre lo necesario y se da de alta con el token existente.
 *
 * El cliente SSH es `ssh2` porque la imagen (`node:24-alpine`) no trae binario `ssh`.
 * Ninguna credencial (contraseña o token) se escribe en el log.
 */

// ── funciones puras (sin red: se prueban en scripts/check-provision.ts) ──────

/** Tamaño del bloque de numeración de WAHA que se reserva por servidor. */
export const WAHA_RANGE_SIZE = 10;

/** Contenedores que deja el instalador de Coolify cuando terminó. */
export const COOLIFY_CONTAINERS = [
  'coolify',
  'coolify-db',
  'coolify-redis',
  'coolify-sentinel',
  'coolify-proxy',
] as const;

const TOKEN_RE = /^\d+\|[A-Za-z0-9]{20,}$/;

/** Un token de equipo de Coolify tiene la forma `id|secreto` (~50 chars). */
export function isCoolifyToken(value: string): boolean {
  return TOKEN_RE.test(value.trim());
}

/**
 * Calcula el próximo rango de WAHA libre a partir de los rangos ya asignados.
 * Sin servidores devuelve el primer bloque `[1, 10]`; si no, arranca donde termina el mayor.
 */
export function nextWahaRange(ranges: Array<[number, number]>): [number, number] {
  let max = 0;
  for (const range of ranges) {
    const [from, to] = range;
    if (Number.isFinite(from)) max = Math.max(max, from);
    if (Number.isFinite(to)) max = Math.max(max, to);
  }
  return [max + 1, max + WAHA_RANGE_SIZE];
}

/** Nombre de variable de entorno sugerido para el token, derivado del alias. */
export function envTokenName(alias: string): string {
  return `${alias.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TOKEN`;
}

export interface FleetEntryInput {
  alias: string;
  name?: string;
  ip: string;
  token: string;
  tokenEnv?: string;
  port?: number;
  projectUuid: string;
  environmentName?: string;
  serverUuid: string;
  destinationUuid: string;
  wahaRange: [number, number];
}

/** Construye la entrada de flota (mismo shape que `config/servers.json`). */
export function buildFleetEntry(input: FleetEntryInput): ServerCfg {
  const port = input.port ?? 8000;
  return {
    alias: input.alias.trim(),
    name: input.name?.trim() || input.alias.trim(),
    url: `http://${input.ip.trim()}:${port}/mcp`,
    tokenEnv: input.tokenEnv ?? envTokenName(input.alias),
    token: input.token.trim(),
    ip: input.ip.trim(),
    projectUuid: input.projectUuid,
    environmentName: input.environmentName ?? 'production',
    serverUuid: input.serverUuid,
    destinationUuid: input.destinationUuid,
    wahaRange: input.wahaRange,
  };
}

/** Extrae el token de la salida de `artisan tinker` (marca `TOKENOUT:`). */
export function parseTokenOutput(stdout: string): string | null {
  const match = /TOKENOUT:\s*(\S+)/.exec(stdout);
  if (!match) return null;
  const token = (match[1] ?? '').trim();
  return isCoolifyToken(token) ? token : null;
}

export interface InstallerLogParse {
  step: number | null;
  totalSteps: number;
  done: boolean;
  containers: string[];
  missing: string[];
}

/**
 * Interpreta el log del instalador y la salida de `docker ps`.
 * Terminado si vio el paso `9/9` o si ya están los cinco contenedores de Coolify.
 */
export function parseInstallerLog(text: string): InstallerLogParse {
  const found = text.match(/\bcoolify(?:-(?:db|redis|sentinel|proxy))?\b/g) ?? [];
  const containers = [...new Set(found)].filter((name): name is string =>
    (COOLIFY_CONTAINERS as readonly string[]).includes(name),
  );

  const stepMatch = /(?:^|[^\d])(\d{1,2})\s*\/\s*9(?!\d)/.exec(text);
  const step = stepMatch ? Number(stepMatch[1]) : null;

  const required = COOLIFY_CONTAINERS as readonly string[];
  const missing = required.filter((c) => !containers.includes(c));
  const containersOk = missing.length === 0;
  const done = (step !== null && step >= 9) || containersOk;

  return { step, totalSteps: 9, done, containers, missing };
}

/** Línea corta y legible del avance del instalador. */
export function formatInstallerProgress(p: InstallerLogParse): string {
  const parts: string[] = [];
  if (p.step !== null) parts.push(`paso ${p.step}/${p.totalSteps}`);
  parts.push(p.containers.length ? `contenedores: ${p.containers.join(', ')}` : 'contenedores: ninguno todavía');
  if (p.done) parts.push('listo');
  else if (p.missing.length) parts.push(`faltan ${p.missing.join(', ')}`);
  return parts.join(' · ');
}

/** Valida una IPv4 simple (los VPS se direccionan por IP). */
export function isIpv4(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value.trim());
  if (!match) return false;
  return match.slice(1).every((part) => Number(part) <= 255);
}

/** Alias por defecto `capiN`, tomando el mayor `capiN` existente. */
export function defaultAlias(existing: string[]): string {
  let max = 0;
  for (const alias of existing) {
    const match = /^capi(\d+)$/i.exec(alias.trim());
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `capi${max + 1}`;
}

// ── SSH (ssh2) ───────────────────────────────────────────────────────────────

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  privateKey?: Buffer;
  password?: string;
}

export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function connect(target: SshTarget): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once('ready', () => resolve(client));
    client.once('error', (err) => reject(err));
    const cfg: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
    };
    if (target.privateKey) cfg.privateKey = target.privateKey;
    if (target.password) cfg.password = target.password;
    client.connect(cfg);
  });
}

/** Ejecuta un comando y devuelve stdout/stderr/código. */
export function execCommand(client: Client, command: string): Promise<SshResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      stream.on('close', (code: number | undefined) => resolve({ code: code ?? 0, stdout, stderr }));
    });
  });
}

// ── Instalación y onboarding de Coolify ──────────────────────────────────────

export interface InstallOptions {
  onProgress?: (line: string) => void;
  pollMs?: number;
  timeoutMs?: number;
}

export interface InstallResult {
  ok: boolean;
  log: string;
}

const INSTALL_CMD = [
  "nohup bash -c 'curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash'",
  '>/root/coolify-install.log 2>&1 </dev/null & echo CAPIOPS_STARTED',
].join(' ');

/**
 * Instala Coolify en un VPS virgen. Lanza el instalador en segundo plano y hace polling
 * del log y de `docker ps` hasta ver el paso `9/9` o los cinco contenedores.
 */
export async function installCoolify(target: SshTarget, opts: InstallOptions = {}): Promise<InstallResult> {
  const pollMs = opts.pollMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 12 * 60_000;
  const client = await connect(target);
  try {
    opts.onProgress?.('conectado por SSH; lanzando el instalador de Coolify…');
    const launch = await execCommand(client, INSTALL_CMD);
    if (!launch.stdout.includes('CAPIOPS_STARTED')) {
      throw new Error('no pude lanzar el instalador (¿permisos de root?)');
    }
    const deadline = Date.now() + timeoutMs;
    let lastLog = '';
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const log = (await execCommand(client, 'tail -n 80 /root/coolify-install.log 2>/dev/null')).stdout;
      const ps = (await execCommand(client, "docker ps --format '{{.Names}}' 2>/dev/null")).stdout;
      lastLog = log;
      const parsed = parseInstallerLog(`${log}\n${ps}`);
      opts.onProgress?.(formatInstallerProgress(parsed));
      if (parsed.done) return { ok: true, log };
    }
    return { ok: false, log: lastLog };
  } finally {
    client.end();
  }
}

const ENABLE_APIS_CMD =
  'docker exec coolify-db psql -U coolify -d coolify -c ' +
  '"update instance_settings set is_mcp_server_enabled=true, is_api_enabled=true;"';

/**
 * Acuña un token de equipo con Sanctum (`User::createToken`), nunca insertando a mano en
 * `personal_access_tokens`. El token se muestra una sola vez: lo capturamos y lo devolvemos.
 */
export async function mintCoolifyToken(target: SshTarget, opts: InstallOptions = {}): Promise<string> {
  const client = await connect(target);
  try {
    opts.onProgress?.('habilitando MCP y API en Coolify…');
    await execCommand(client, ENABLE_APIS_CMD);
    opts.onProgress?.('acuñando token de equipo (Sanctum)…');
    const php = [
      '$u = App\\Models\\User::first();',
      "$t = $u->createToken('capi-ops', ['read','write','deploy','root'], null, 0);",
      "echo 'TOKENOUT:' . $t->plainTextToken;",
    ].join(' ');
    const escaped = php.replace(/\$/g, '\\$');
    const res = await execCommand(
      client,
      `docker exec coolify php artisan tinker --execute="${escaped}"`,
    );
    const token = parseTokenOutput(res.stdout);
    if (!token) throw new Error('no pude leer el token acuñado con tinker');
    return token;
  } finally {
    client.end();
  }
}

export interface CoolifyDiscovery {
  serverUuid: string;
  destinationUuid: string;
  projectUuid: string;
  environmentName: string;
}

async function apiRequest(
  ip: string,
  port: number,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const res = await fetch(`http://${ip}:${port}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 150)}` : ''} en ${path}`);
  return text ? JSON.parse(text) : null;
}

function asList(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  const data = (value as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}

/**
 * Descubre los UUID que necesita la flota usando la API REST del propio Coolify:
 * servidor localhost, su destino de Docker `standalone` y un proyecto propio.
 */
export async function discoverCoolify(
  ip: string,
  token: string,
  opts: { port?: number; projectName?: string; onProgress?: (line: string) => void } = {},
): Promise<CoolifyDiscovery> {
  const port = opts.port ?? 8000;
  opts.onProgress?.('descubriendo UUIDs por la API de Coolify…');

  const servers = asList(await apiRequest(ip, port, token, '/servers'));
  const local =
    servers.find((s) => String(s['name'] ?? '').toLowerCase() === 'localhost') ?? servers[0];
  const serverUuid = typeof local?.['uuid'] === 'string' ? (local['uuid'] as string) : '';
  if (!serverUuid) throw new Error('no encontré el servidor localhost en Coolify');

  const destinations = asList(await apiRequest(ip, port, token, `/servers/${serverUuid}/destinations`));
  const standalone =
    destinations.find((d) => String(d['name'] ?? '').toLowerCase() === 'standalone') ?? destinations[0];
  const destinationUuid =
    typeof standalone?.['uuid'] === 'string' ? (standalone['uuid'] as string) : '';
  if (!destinationUuid) throw new Error('no encontré un destino de Docker en el servidor');

  const project = (await apiRequest(ip, port, token, '/projects', {
    method: 'POST',
    body: JSON.stringify({ name: opts.projectName ?? 'capi-ops' }),
  })) as { uuid?: string; data?: { uuid?: string } } | null;
  const projectUuid = project?.uuid ?? project?.data?.uuid ?? '';
  if (!projectUuid) throw new Error('no pude crear el proyecto en Coolify');

  return { serverUuid, destinationUuid, projectUuid, environmentName: 'production' };
}

export interface Onboarding extends CoolifyDiscovery {
  token: string;
}

/** Onboarding completo de un Coolify recién instalado: token + UUIDs. */
export async function onboardCoolify(target: SshTarget, opts: OnboardingOptions = {}): Promise<Onboarding> {
  const token = await mintCoolifyToken(target, opts);
  const discovery = await discoverCoolify(target.host, token, {
    port: opts.apiPort,
    projectName: opts.projectName,
    onProgress: opts.onProgress,
  });
  return { token, ...discovery };
}

export interface OnboardingOptions extends InstallOptions {
  apiPort?: number;
  projectName?: string;
}
