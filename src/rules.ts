import type { ServerSnapshot, Severity, WahaHealth } from './types.js';

export interface Finding {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
}

export interface RuleThresholds {
  cpu: number;
  mem: number;
  diskWarn: number;
  diskCrit: number;
  load1: number;
}

export interface Baseline {
  mean: number;
  sd: number;
  n: number;
}

export interface RuleContext {
  thresholds: RuleThresholds;
  baseline?: (alias: string, column: 'cpu' | 'mem_percent' | 'load1') => Baseline;
  wahaHealth: Map<string, WahaHealth[]>;
}

export function evaluate(snapshot: ServerSnapshot, ctx: RuleContext): Finding[] {
  const out: Finding[] = [];
  const { alias, metrics } = snapshot;

  if (!snapshot.reachable) {
    out.push({
      key: `srv:${alias}:down`,
      severity: 'critica',
      title: `${snapshot.name} (${snapshot.ip}) no responde`,
      detail: snapshot.lastError ?? 'El MCP no respondió en el último ciclo.',
    });
    return out;
  }

  if (metrics.cpuPercent !== null && metrics.cpuPercent >= ctx.thresholds.cpu) {
    out.push({
      key: `srv:${alias}:cpu`,
      severity: 'alta',
      title: `CPU alta en ${snapshot.name}`,
      detail: `CPU ${metrics.cpuPercent.toFixed(0)}% (umbral ${ctx.thresholds.cpu}%)`,
    });
  }

  if (metrics.memPercent !== null && metrics.memPercent >= ctx.thresholds.mem) {
    out.push({
      key: `srv:${alias}:mem`,
      severity: 'alta',
      title: `Memoria alta en ${snapshot.name}`,
      detail: `Memoria ${metrics.memPercent.toFixed(0)}% (umbral ${ctx.thresholds.mem}%)`,
    });
  }

  if (metrics.diskPercent !== null) {
    if (metrics.diskPercent >= ctx.thresholds.diskCrit) {
      out.push({
        key: `srv:${alias}:disk`,
        severity: 'critica',
        title: `Disco crítico en ${snapshot.name}`,
        detail: `Disco ${metrics.diskPercent.toFixed(0)}% (crítico ${ctx.thresholds.diskCrit}%)`,
      });
    } else if (metrics.diskPercent >= ctx.thresholds.diskWarn) {
      out.push({
        key: `srv:${alias}:disk`,
        severity: 'alta',
        title: `Disco alto en ${snapshot.name}`,
        detail: `Disco ${metrics.diskPercent.toFixed(0)}% (umbral ${ctx.thresholds.diskWarn}%)`,
      });
    }
  }

  if (metrics.load1 !== null && metrics.load1 > ctx.thresholds.load1) {
    out.push({
      key: `srv:${alias}:load`,
      severity: 'media',
      title: `Load alto en ${snapshot.name}`,
      detail: `load1 ${metrics.load1.toFixed(2)} (umbral ${ctx.thresholds.load1})`,
    });
  }

  if (ctx.baseline && metrics.cpuPercent !== null && metrics.cpuPercent > 15) {
    const b = ctx.baseline(alias, 'cpu');
    if (b.n >= 30 && b.sd > 1) {
      const z = (metrics.cpuPercent - b.mean) / b.sd;
      if (z > 3) {
        out.push({
          key: `srv:${alias}:anomaly-cpu`,
          severity: 'media',
          title: `CPU anómala en ${snapshot.name}`,
          detail: `CPU ${metrics.cpuPercent.toFixed(0)}% vs media ${b.mean.toFixed(0)}% (z=${z.toFixed(1)}, n=${b.n})`,
        });
      }
    }
  }

  const down = snapshot.apps.filter((a) => !a.status.startsWith('running'));
  if (down.length > 0) {
    out.push({
      key: `srv:${alias}:containers`,
      severity: 'alta',
      title: `${down.length} contenedor(es) caído(s) en ${snapshot.name}`,
      detail: down
        .slice(0, 10)
        .map((a) => `${a.name}: ${a.status}`)
        .join('\n'),
    });
  }

  if (snapshot.openDeployments > 3) {
    out.push({
      key: `srv:${alias}:deploy-queue`,
      severity: 'media',
      title: `Cola de deploys trabada en ${snapshot.name}`,
      detail: `${snapshot.openDeployments} deployments en cola o en curso`,
    });
  }

  const health = ctx.wahaHealth.get(alias);
  if (health && health.length > 0) {
    const dnsBad = health.filter((h) => !h.dnsOk);
    const httpBad = health.filter((h) => h.dnsOk && !h.httpOk);
    if (dnsBad.length > 0) {
      out.push({
        key: `srv:${alias}:waha-dns`,
        severity: 'media',
        title: `${dnsBad.length} dominio(s) WAHA sin DNS correcto (${snapshot.name})`,
        detail: dnsBad
          .slice(0, 10)
          .map((h) => `${h.name}: ${h.domain} -> ${h.resolved.join(',') || 'sin registro'}`)
          .join('\n'),
      });
    }
    if (httpBad.length > 0) {
      const pct = (httpBad.length / health.length) * 100;
      out.push({
        key: `srv:${alias}:waha-http`,
        severity: pct >= 20 ? 'alta' : 'media',
        title: `${httpBad.length}/${health.length} WAHA no responden (${snapshot.name})`,
        detail: httpBad
          .slice(0, 10)
          .map((h) => `${h.name}: ${h.error ?? 'sin respuesta'}`)
          .join('\n'),
      });
    }
  }

  return out;
}
