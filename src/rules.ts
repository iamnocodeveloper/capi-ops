import type { EpSnapshot, ServerSnapshot, Severity, WahaHealth } from './types.js';

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

function fmtGb(value: number | null): string {
  return value === null ? '–' : `${value.toFixed(1)} GB`;
}

/** Reglas del host EasyPanel y sus servicios. Todas las claves empiezan con `ep:`. */
export function evaluateEasyPanel(
  snapshot: EpSnapshot,
  thresholds: RuleThresholds,
  serviceCpuThreshold: number,
): Finding[] {
  const out: Finding[] = [];
  const label = `${snapshot.name} (${snapshot.ip})`;

  if (!snapshot.reachable) {
    out.push({
      key: `ep:${snapshot.alias}:host:down`,
      severity: 'critica',
      title: `EasyPanel · ${label} no responde`,
      detail: snapshot.lastError ?? 'La API de EasyPanel no respondió en el último ciclo.',
    });
    return out;
  }

  if (snapshot.cpuPercent !== null && snapshot.cpuPercent >= thresholds.cpu) {
    out.push({
      key: `ep:${snapshot.alias}:host:cpu`,
      severity: 'alta',
      title: `EasyPanel · CPU alta en el servidor`,
      detail: `CPU ${snapshot.cpuPercent.toFixed(0)}% (umbral ${thresholds.cpu}%) · ${snapshot.cores ?? '?'} cores`,
    });
  }

  if (snapshot.memPercent !== null && snapshot.memPercent >= thresholds.mem) {
    out.push({
      key: `ep:${snapshot.alias}:host:mem`,
      severity: 'alta',
      title: `EasyPanel · memoria alta en el servidor`,
      detail: `Memoria ${snapshot.memPercent.toFixed(0)}% (umbral ${thresholds.mem}%)`,
    });
  }

  if (snapshot.diskPercent !== null) {
    const detail = `Disco ${snapshot.diskPercent.toFixed(1)}% (${fmtGb(snapshot.diskUsedGb)} de ${fmtGb(snapshot.diskTotalGb)})`;
    if (snapshot.diskPercent >= thresholds.diskCrit) {
      out.push({
        key: `ep:${snapshot.alias}:host:disk`,
        severity: 'critica',
        title: `EasyPanel · disco crítico en el servidor`,
        detail,
      });
    } else if (snapshot.diskPercent >= thresholds.diskWarn) {
      out.push({
        key: `ep:${snapshot.alias}:host:disk`,
        severity: 'alta',
        title: `EasyPanel · disco alto en el servidor`,
        detail,
      });
    }
  }

  if (snapshot.load1 !== null && snapshot.load1 > thresholds.load1) {
    out.push({
      key: `ep:${snapshot.alias}:host:load`,
      severity: 'media',
      title: `EasyPanel · load alto en el servidor`,
      detail: `load1 ${snapshot.load1.toFixed(2)} (umbral ${thresholds.load1})`,
    });
  }

  if (snapshot.updateAvailable) {
    out.push({
      key: `ep:${snapshot.alias}:update`,
      severity: 'media',
      title: `EasyPanel · actualización disponible`,
      detail: snapshot.updateVersion
        ? `Nueva versión ${snapshot.updateVersion}. Actualizá desde el panel cuando puedas.`
        : 'Hay una versión nueva de EasyPanel para instalar.',
    });
  }

  for (const service of snapshot.services) {
    if (service.state === 'down') {
      out.push({
        key: `ep:${snapshot.alias}:svc:${service.key}:down`,
        severity: 'alta',
        title: `EasyPanel · ${service.project}/${service.name} caído`,
        detail: [
          `cliente/proyecto: ${service.project}`,
          `servicio: ${service.name} (${service.type})`,
          service.host ? `dominio: ${service.host}` : '',
          `contenedores: ${service.actual}/${service.desired}`,
        ]
          .filter(Boolean)
          .join('\n'),
      });
    } else if (service.httpOk === false) {
      out.push({
        key: `ep:${snapshot.alias}:svc:${service.key}:http`,
        severity: 'alta',
        title: `EasyPanel · ${service.project}/${service.name} no responde por HTTP`,
        detail: [
          `cliente/proyecto: ${service.project}`,
          `servicio: ${service.name}`,
          `url: ${service.url ?? '–'}`,
          `error: ${service.httpError ?? 'sin respuesta'}`,
        ].join('\n'),
      });
    }

    if (service.cpuPercent !== null && service.cpuPercent >= serviceCpuThreshold) {
      out.push({
        key: `ep:${snapshot.alias}:svc:${service.key}:cpu`,
        severity: 'media',
        title: `EasyPanel · ${service.project}/${service.name} con CPU alta`,
        detail: `CPU ${service.cpuPercent.toFixed(0)}% (umbral ${serviceCpuThreshold}%)`,
      });
    }
  }

  return out;
}
