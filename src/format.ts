import type { Severity } from './types.js';

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtPct(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  return `${v.toFixed(digits)}%`;
}

export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function pre(text: string): string {
  return `<pre>${esc(text)}</pre>`;
}

export function severityIcon(s: Severity): string {
  switch (s) {
    case 'critica':
      return '🚨';
    case 'alta':
      return '🔴';
    case 'media':
      return '🟡';
    default:
      return 'ℹ️';
  }
}

export function severityRank(s: Severity): number {
  return { info: 0, media: 1, alta: 2, critica: 3 }[s];
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('es-AR', {
    timeZone: process.env.TZ ?? 'America/Argentina/Buenos_Aires',
    hour12: false,
  });
}

export function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

export function table(rows: string[][], headers: string[]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : pad(c, widths[i] ?? c.length)))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map((r) => line(r.map((c) => c ?? '')))].join('\n');
}
