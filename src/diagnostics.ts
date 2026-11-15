import type { ServerCfg } from './types.js';
import { runSsh } from './ssh.js';

export type ReasonCode =
  | 'primary-logged-out'
  | 'logout-other-device'
  | 'device-removed'
  | 'logout-api'
  | 'logged-out'
  | 'qr-expired'
  | 'engine'
  | 'network'
  | 'unknown';

export interface ReasonInfo {
  code: ReasonCode;
  label: string;
  action: string;
}

const REASONS: Record<ReasonCode, ReasonInfo> = {
  'primary-logged-out': {
    code: 'primary-logged-out',
    label: 'Logout de WhatsApp — el teléfono principal cerró sesión (403)',
    action: 'Volver a vincular por QR. No es motor ni proxy.',
  },
  'logout-other-device': {
    code: 'logout-other-device',
    label: 'Logout de WhatsApp — sesión cerrada desde otro dispositivo (401)',
    action: 'Revisar quién usó la cuenta y volver a vincular por QR.',
  },
  'device-removed': {
    code: 'device-removed',
    label: 'Logout de WhatsApp — dispositivo desvinculado',
    action: 'Volver a vincular por QR (Dispositivos vinculados).',
  },
  'logout-api': {
    code: 'logout-api',
    label: 'Logout por API (DELETE /api/sessions)',
    action: 'Auditar la integración/panel que llamó al logout.',
  },
  'logged-out': {
    code: 'logged-out',
    label: 'Logout de WhatsApp (sin código 401/403 en el log)',
    action: 'Volver a vincular por QR y revisar Dispositivos vinculados.',
  },
  'qr-expired': {
    code: 'qr-expired',
    label: 'QR expirado / nadie escaneó a tiempo',
    action: 'Generar un QR nuevo y vincular.',
  },
  engine: {
    code: 'engine',
    label: 'Error del motor GOWS',
    action: 'Reiniciar la sesión; si persiste, reiniciar el contenedor.',
  },
  network: {
    code: 'network',
    label: 'Error de red / proxy / DNS',
    action: 'Revisar proxy de la sesión, DNS y conectividad del host.',
  },
  unknown: {
    code: 'unknown',
    label: 'Sin evento concluyente en la ventana',
    action: 'Ampliá la ventana (±30m / día) o revisá /historial <instancia> <sesión> 5.',
  },
};

export function reasonInfo(code: ReasonCode): ReasonInfo {
  return REASONS[code];
}

export interface DiagEvent {
  at: number | null;
  code: ReasonCode;
  text: string;
}

const EVENT_PATTERNS: Array<{ code: ReasonCode; re: RegExp }> = [
  { code: 'primary-logged-out', re: /Got 403:\s*primary device was logged out/i },
  { code: 'logout-other-device', re: /Got 401:\s*logged out from another device/i },
  { code: 'device-removed', re: /Got device removed stream error/i },
  { code: 'logout-api', re: /Session has been logged out|Unpairing the device from account/i },
  { code: 'logged-out', re: /- Logged out\b/ },
  { code: 'qr-expired', re: /QR code.*(expired|invalid)|SCAN_QR_CODE/i },
  { code: 'engine', re: /panic|engine start failure|failed to start session|session has been stopped unexpectedly/i },
  { code: 'network', re: /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|proxy connect|ECONNRESET/i },
];

const LOG_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(?:\s|$)/;

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

export function logLines(raw: string): string[] {
  return stripAnsi(raw)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

export function lineTimestamp(line: string): number | null {
  const m = LOG_LINE.exec(line);
  if (!m?.[1]) return null;
  const ts = Date.parse(m[1]);
  return Number.isFinite(ts) ? ts : null;
}

export function eventOfLine(line: string): DiagEvent | null {
  for (const pattern of EVENT_PATTERNS) {
    if (pattern.re.test(line)) {
      return { at: lineTimestamp(line), code: pattern.code, text: stripTimestamps(line) };
    }
  }
  return null;
}

function stripTimestamps(line: string): string {
  return line.replace(LOG_LINE, '').replace(/^\[\d{2}:\d{2}:\d{2}(?:\.\d+)?\]\s*/, '').trim();
}

export function cleanLine(line: string): string {
  return stripTimestamps(line);
}

/** IP pública del host (sin entrar al contenedor). */
export async function hostPublicIp(server: ServerCfg): Promise<string | null> {
  const raw = await runSsh(server, `curl -s --max-time 8 https://api.ipify.org || true`, {
    timeoutMs: 15_000,
    maxBytes: 4_096,
  });
  return logLines(raw).find((line) => /^\d{1,3}(\.\d{1,3}){3}$/.test(line.trim()))?.trim() ?? null;
}

export function extractEvents(raw: string, session?: string): DiagEvent[] {
  const wanted = session?.toLowerCase();
  const events: DiagEvent[] = [];
  for (const line of logLines(raw)) {
    if (wanted && !line.toLowerCase().includes(wanted)) continue;
    const event = eventOfLine(line);
    if (event) events.push(event);
  }
  return events;
}

const PRIORITY: ReasonCode[] = [
  'primary-logged-out',
  'logout-other-device',
  'device-removed',
  'logout-api',
  'logged-out',
  'qr-expired',
  'engine',
  'network',
];

export function pickReason(events: DiagEvent[]): { code: ReasonCode; event: DiagEvent | null } {
  for (const code of PRIORITY) {
    const matches = events.filter((e) => e.code === code);
    if (matches.length) return { code, event: matches[matches.length - 1] ?? null };
  }
  return { code: 'unknown', event: null };
}

export function relevantLines(raw: string, session?: string, limit = 12): string[] {
  const wanted = session?.toLowerCase();
  return logLines(raw)
    .filter((line) => {
      if (wanted && line.toLowerCase().includes(wanted)) return true;
      return eventOfLine(line) !== null;
    })
    .slice(-limit);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assertToken(value: string, label: string): string {
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(value)) {
    throw new Error(`${label} inválido`);
  }
  return value;
}

function assertUuid(value: string): string {
  if (!/^[a-z0-9]{6,40}$/i.test(value)) throw new Error('uuid inválido');
  return value;
}

const SED_ANSI = `sed -e 's/\\x1b\\[[0-9;]*m//g'`;

/** Nombre real del contenedor Docker de una app de Coolify (prefijo = uuid). */
export async function resolveContainer(server: ServerCfg, appUuid: string): Promise<string> {
  const uuid = assertUuid(appUuid);
  const out = await runSsh(
    server,
    `docker ps --filter name=${shellQuote(uuid)} --format '{{.Names}}' | head -n 1`,
    { timeoutMs: 12_000, maxBytes: 4_096 },
  );
  const name = logLines(out)[0];
  if (!name) throw new Error(`no encontré el contenedor de ${appUuid} en ${server.alias}`);
  return assertToken(name, 'contenedor');
}

export interface LogWindowOptions {
  since: Date;
  until: Date;
  maxLines?: number;
}

export async function logsWindow(
  server: ServerCfg,
  container: string,
  options: LogWindowOptions,
): Promise<string> {
  const name = assertToken(container, 'contenedor');
  const maxLines = Math.min(Math.max(options.maxLines ?? 3_000, 50), 5_000);
  const command = [
    `docker logs -t --since ${shellQuote(options.since.toISOString())} --until ${shellQuote(options.until.toISOString())} ${shellQuote(name)} 2>&1`,
    SED_ANSI,
    `grep -v 'request completed'`,
    `tail -n ${maxLines}`,
  ].join(' | ');
  return runSsh(server, command, { timeoutMs: 25_000, maxBytes: 1_048_576 });
}

export interface HistoryOptions {
  session?: string;
  days?: number;
  maxLines?: number;
}

/** Eventos de logout/fallo en todo el log retenido (docker suele guardar ~5 días). */
export async function logoutEvents(
  server: ServerCfg,
  container: string,
  options: HistoryOptions = {},
): Promise<DiagEvent[]> {
  const name = assertToken(container, 'contenedor');
  const days = Math.min(Math.max(options.days ?? 5, 1), 30);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const filter = options.session ? `grep -i -F -- ${shellQuote(options.session)} | ` : '';
  const command = [
    `docker logs -t --since ${shellQuote(since)} ${shellQuote(name)} 2>&1`,
    SED_ANSI,
    `grep -iE 'Logged out|device removed|Got 40[13]|primary device|Unpairing the device|QR code.*(expired|invalid)|SCAN_QR_CODE|panic|engine start failure'`,
    `${filter}tail -n ${Math.min(Math.max(options.maxLines ?? 400, 50), 1_000)}`,
  ].join(' | ');
  const raw = await runSsh(server, command, { timeoutMs: 25_000, maxBytes: 1_048_576 });
  // Un mismo logout genera 2-3 líneas casi simultáneas (Unpairing, Logged out, 403).
  // Se colapsan por segundo + sesión, quedándose con el motivo más específico.
  const byEvent = new Map<string, { rank: number; event: DiagEvent }>();
  for (const line of logLines(raw)) {
    const event = eventOfLine(line);
    if (!event) continue;
    const sessionName = /(?:session:|\[Session\/)([A-Za-z0-9._-]+)/.exec(event.text)?.[1] ?? '';
    const bucket = event.at === null ? '' : Math.floor(event.at / 5_000);
    const key = `${bucket}:${sessionName}`;
    const rank = PRIORITY.length - PRIORITY.indexOf(event.code);
    const existing = byEvent.get(key);
    if (!existing || rank > existing.rank) byEvent.set(key, { rank, event });
  }
  return [...byEvent.values()]
    .map((item) => item.event)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

export interface NetworkInfo {
  hostIp: string | null;
  containerIp: string | null;
  proxyVars: string[];
}

/** IP pública del host y del contenedor, más variables de proxy del contenedor. */
export async function networkInfo(server: ServerCfg, container: string): Promise<NetworkInfo> {
  const name = assertToken(container, 'contenedor');
  const command = [
    `echo '@@HOST'`,
    `curl -s --max-time 8 https://api.ipify.org || true`,
    `echo ''`,
    `echo '@@CONT'`,
    `docker exec ${shellQuote(name)} sh -c 'curl -s --max-time 8 https://api.ipify.org || wget -qO- --timeout=8 https://api.ipify.org' || true`,
    `echo ''`,
    `echo '@@ENV'`,
    `docker inspect ${shellQuote(name)} --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -i proxy || true`,
  ].join('; ');
  const raw = await runSsh(server, command, { timeoutMs: 25_000, maxBytes: 32_768 });
  const sections = new Map<string, string[]>();
  let current = '';
  for (const line of logLines(raw)) {
    if (line.startsWith('@@')) {
      current = line.slice(2).trim();
      sections.set(current, []);
      continue;
    }
    sections.get(current)?.push(line);
  }
  const first = (key: string): string | null => sections.get(key)?.find((l) => l.trim().length > 0)?.trim() ?? null;
  return {
    hostIp: first('HOST'),
    containerIp: first('CONT'),
    proxyVars: (sections.get('ENV') ?? []).map((l) => l.trim()).filter(Boolean),
  };
}

/** Proxy configurado por contenedor en todo el servidor. */
export async function proxyByContainer(server: ServerCfg): Promise<Map<string, string[]>> {
  const command = [
    `docker ps --format '{{.Names}}' | grep -v '^coolify' | while read c; do`,
    `echo "== $c";`,
    `docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -i proxy || echo none;`,
    `done`,
  ].join(' ');
  const raw = await runSsh(server, command, { timeoutMs: 30_000, maxBytes: 131_072 });
  const result = new Map<string, string[]>();
  let current = '';
  for (const line of logLines(raw)) {
    if (line.startsWith('== ')) {
      current = line.slice(3).trim();
      result.set(current, []);
      continue;
    }
    if (!current) continue;
    if (line.trim() === 'none') continue;
    result.get(current)?.push(line.trim());
  }
  return result;
}
