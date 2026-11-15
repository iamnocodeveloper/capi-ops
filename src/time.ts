const DEFAULT_TZ = process.env.DIAG_TZ ?? 'America/Argentina/Buenos_Aires';

interface ZoneParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

function partsInZone(date: Date, timeZone: string): ZoneParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return {
    y: Number(out['year']),
    m: Number(out['month']),
    d: Number(out['day']),
    hh: Number(out['hour']),
    mm: Number(out['minute']),
    ss: Number(out['second']),
  };
}

function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = partsInZone(date, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Fecha/hora local (por defecto ART) → instante UTC. */
export function fromZone(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  timeZone = DEFAULT_TZ,
): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  const offset = zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess - offset);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function fmtArt(ts: number | Date, timeZone = DEFAULT_TZ): string {
  const date = typeof ts === 'number' ? new Date(ts) : ts;
  const p = partsInZone(date, timeZone);
  return `${pad2(p.d)}/${pad2(p.m)} ${pad2(p.hh)}:${pad2(p.mm)}:${pad2(p.ss)}`;
}

export function fmtArtTime(ts: number | Date, timeZone = DEFAULT_TZ): string {
  const date = typeof ts === 'number' ? new Date(ts) : ts;
  const p = partsInZone(date, timeZone);
  return `${pad2(p.hh)}:${pad2(p.mm)}:${pad2(p.ss)}`;
}

export function fmtArtDay(ts: number | Date, timeZone = DEFAULT_TZ): string {
  const date = typeof ts === 'number' ? new Date(ts) : ts;
  const p = partsInZone(date, timeZone);
  return `${pad2(p.d)}/${pad2(p.m)}`;
}

export interface ParsedWhen {
  since: Date;
  until: Date;
  label: string;
  /** Presente cuando el usuario indicó un instante puntual (HH:MM). */
  point?: Date;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DEFAULT_AROUND_MS = 10 * MINUTE;

function pointWindow(point: Date, aroundMs = DEFAULT_AROUND_MS): ParsedWhen {
  return {
    since: new Date(point.getTime() - aroundMs),
    until: new Date(point.getTime() + aroundMs),
    label: fmtArt(point),
    point,
  };
}

/**
 * Interpreta el "cuándo" de los comandos en la zona configurada (ART por defecto).
 * Acepta: `11:30`, `03/11 11:43`, `03/11/2026 11:43`, `03/11`, `hoy`, `ayer`,
 * `ayer 06:35`, `2h`, `30m`. Sin argumento devuelve las últimas 2 horas.
 */
export function parseWhen(input?: string, now = Date.now(), timeZone = DEFAULT_TZ): ParsedWhen {
  const raw = (input ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const nowParts = partsInZone(new Date(now), timeZone);

  if (!raw) {
    return { since: new Date(now - 2 * HOUR), until: new Date(now), label: 'últimas 2 h' };
  }

  const duration = /^(\d+)\s*([mh])$/.exec(raw);
  if (duration) {
    const n = Number(duration[1]);
    const unit = duration[2] === 'h' ? HOUR : MINUTE;
    return { since: new Date(now - n * unit), until: new Date(now), label: `últimas ${n}${duration[2]}` };
  }

  const dayPrefix = /^(hoy|ayer)\b\s*(.*)$/.exec(raw);
  if (dayPrefix) {
    const [, prefix, rest] = dayPrefix;
    const offset = prefix === 'ayer' ? -1 : 0;
    // Se opera sobre la fecha calendario (UTC), sin volver a interpretarla en la zona.
    const calendar = new Date(Date.UTC(nowParts.y, nowParts.m - 1, nowParts.d + offset));
    const y = calendar.getUTCFullYear();
    const m = calendar.getUTCMonth() + 1;
    const d = calendar.getUTCDate();
    const time = rest ? /^(\d{1,2}):(\d{2})$/.exec(rest) : null;
    if (time) {
      const point = fromZone(y, m, d, Number(time[1]), Number(time[2]), timeZone);
      return pointWindow(point);
    }
    const start = fromZone(y, m, d, 0, 0, timeZone);
    return {
      since: start,
      until: new Date(start.getTime() + 86_400_000),
      label: prefix === 'ayer' ? 'ayer' : 'hoy',
    };
  }

  const dateTime = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?:\s+(\d{1,2}):(\d{2}))?$/.exec(raw);
  if (dateTime) {
    const day = Number(dateTime[1]);
    const month = Number(dateTime[2]);
    const yearRaw = dateTime[3];
    const year = yearRaw ? Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw) : nowParts.y;
    const hour = dateTime[4] === undefined ? null : Number(dateTime[4]);
    const minute = dateTime[5] === undefined ? 0 : Number(dateTime[5]);
    if (hour === null) {
      const start = fromZone(year, month, day, 0, 0, timeZone);
      return { since: start, until: new Date(start.getTime() + 86_400_000), label: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}` };
    }
    const point = fromZone(year, month, day, hour, minute, timeZone);
    return pointWindow(point);
  }

  const onlyTime = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (onlyTime) {
    const point = fromZone(nowParts.y, nowParts.m, nowParts.d, Number(onlyTime[1]), Number(onlyTime[2]), timeZone);
    return pointWindow(point);
  }

  throw new Error(`no entendí "${input}". Usá 11:30, 03/11 11:43, ayer 06:35, hoy o 2h`);
}

/** Ventana total alrededor de un instante puntual (ej. `30m` → ±15 min). */
export function windowAround(point: Date, window: string): ParsedWhen {
  const m = /^(\d+)\s*([mh])$/.exec(window.trim().toLowerCase());
  if (!m) throw new Error(`ventana inválida "${window}". Usá 10m, 30m o 2h`);
  const ms = Number(m[1]) * (m[2] === 'h' ? HOUR : MINUTE);
  return {
    since: new Date(point.getTime() - ms),
    until: new Date(point.getTime() + ms),
    label: `${fmtArt(point)} ±${m[1]}${m[2]}`,
    point,
  };
}

export function diagTimeZone(): string {
  return DEFAULT_TZ;
}
