import type { Db } from './db.js';
import type { Finding } from './rules.js';
import type { Severity } from './types.js';
import { severityIcon, severityRank } from './format.js';

export interface QuietHours {
  from: number; // minutos desde 00:00
  to: number;
}

export function parseQuietHours(raw: string): QuietHours | null {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [, h1, m1, h2, m2] = m;
  return {
    from: Number(h1) * 60 + Number(m1),
    to: Number(h2) * 60 + Number(m2),
  };
}

export function inQuietHours(q: QuietHours | null, now = new Date()): boolean {
  if (!q) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (q.from === q.to) return false;
  if (q.from < q.to) return minutes >= q.from && minutes < q.to;
  return minutes >= q.from || minutes < q.to;
}

export type Notifier = (text: string, severity: Severity) => Promise<void>;

export interface EngineOptions {
  renotifyMs: number;
  quiet: QuietHours | null;
  log?: (line: string) => void;
}

/**
 * Reconcilia el estado de la flota contra los incidentes abiertos:
 * abre lo nuevo, re-notifica lo vigente (con cooldown) y cierra lo que ya no aplica.
 */
export class AlertEngine {
  constructor(
    private readonly db: Db,
    private readonly notify: Notifier,
    private readonly opts: EngineOptions,
  ) {}

  async reconcile(findings: Finding[]): Promise<void> {
    const active = new Map(findings.map((f) => [f.key, f]));
    const now = Date.now();

    for (const finding of findings) {
      const open = this.db.openIncident(finding.key);
      if (!open) {
        const row = this.db.createIncident(finding.key, finding.severity, finding.title, finding.detail);
        await this.maybeNotify(row.severity, this.renderOpen(finding));
        this.opts.log?.(`incidente abierto: ${finding.key} (${finding.severity})`);
        continue;
      }

      const severityChanged = open.severity !== finding.severity;
      const due = now - open.last_notified_at >= this.opts.renotifyMs;

      if (severityChanged || due) {
        this.db.touchIncident(open.id, finding.detail, finding.severity);
        const header = severityChanged ? this.renderEscalated(finding, open.severity) : this.renderStillOpen(finding);
        await this.maybeNotify(finding.severity, header);
        this.opts.log?.(`re-notificado: ${finding.key}`);
      } else {
        this.db.raw
          .prepare('UPDATE incidents SET detail = ? WHERE id = ?')
          .run(finding.detail, open.id);
      }
    }

    const openIncidents = this.db.openIncidents();
    for (const incident of openIncidents) {
      if (active.has(incident.key)) continue;
      const resolved = this.db.resolveIncident(incident.key);
      if (!resolved) continue;
      this.opts.log?.(`incidente resuelto: ${incident.key}`);
      await this.maybeNotify('info', [
        `✅ <b>Recuperado</b> — ${escape(resolved.title)}`,
        `<i>Abierto ${minutesAgo(resolved.opened_at)}</i>`,
      ].join('\n'));
    }
  }

  private renderOpen(f: Finding): string {
    return [
      `${severityIcon(f.severity)} <b>${escape(f.title)}</b>`,
      `<i>${f.severity.toUpperCase()}</i>`,
      f.detail ? `<pre>${escape(f.detail)}</pre>` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private renderEscalated(f: Finding, previous: Severity): string {
    const dir = severityRank(f.severity) > severityRank(previous) ? 'escaló' : 'bajó';
    return [
      `${severityIcon(f.severity)} <b>${escape(f.title)}</b>`,
      `<i>${f.severity.toUpperCase()} · ${dir} desde ${previous}</i>`,
      f.detail ? `<pre>${escape(f.detail)}</pre>` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private renderStillOpen(f: Finding): string {
    return [
      `${severityIcon(f.severity)} <b>Sigue abierto</b> — ${escape(f.title)}`,
      f.detail ? `<pre>${escape(f.detail)}</pre>` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async maybeNotify(severity: Severity, text: string): Promise<void> {
    if (inQuietHours(this.opts.quiet) && severity !== 'critica') {
      this.opts.log?.(`silenciado por horario: ${text.split('\n')[0]}`);
      return;
    }
    await this.notify(text, severity);
  }
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function minutesAgo(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}
