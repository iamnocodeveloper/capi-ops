import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, evaluateEasyPanel, type RuleContext } from '../src/rules.js';
import type { EpService, EpSnapshot, ServerSnapshot, WahaHealth } from '../src/types.js';

function snapshot(overrides: Partial<ServerSnapshot> = {}): ServerSnapshot {
  return {
    alias: 'capi1',
    name: 'Servidor 1',
    ip: '10.0.0.1',
    reachable: true,
    metrics: {
      online: true,
      cpuPercent: 5,
      memUsedBytes: null,
      memTotalBytes: null,
      memPercent: 20,
      diskPercent: 30,
      load1: 0.5,
      netRx: null,
      netTx: null,
    },
    apps: [],
    unhealthy: [],
    openDeployments: 0,
    lastError: null,
    collectedAt: 0,
    ...overrides,
  };
}

function context(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    thresholds: { cpu: 85, mem: 90, diskWarn: 80, diskCrit: 90, load1: 8 },
    wahaHealth: new Map(),
    ...overrides,
  };
}

function keys(findings: Array<{ key: string }>): string[] {
  return findings.map((f) => f.key).sort();
}

test('un servidor sano no genera hallazgos', () => {
  assert.deepEqual(evaluate(snapshot(), context()), []);
});

test('servidor inalcanzable: un solo incidente crítico', () => {
  const findings = evaluate(snapshot({ reachable: false, lastError: 'timeout' }), context());
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.key, 'srv:capi1:down');
  assert.equal(findings[0]?.severity, 'critica');
  assert.match(findings[0]?.detail ?? '', /timeout/);
});

test('CPU y memoria por encima del umbral', () => {
  const findings = evaluate(
    snapshot({
      metrics: { ...snapshot().metrics, cpuPercent: 90, memPercent: 92 },
    }),
    context(),
  );
  assert.deepEqual(keys(findings), ['srv:capi1:cpu', 'srv:capi1:mem']);
  assert.ok(findings.every((f) => f.severity === 'alta'));
});

test('disco: crítico, alto y por debajo del umbral', () => {
  const metrics = snapshot().metrics;
  const crit = evaluate(snapshot({ metrics: { ...metrics, diskPercent: 90 } }), context());
  assert.equal(crit[0]?.key, 'srv:capi1:disk');
  assert.equal(crit[0]?.severity, 'critica');

  const warn = evaluate(snapshot({ metrics: { ...metrics, diskPercent: 80 } }), context());
  assert.equal(warn[0]?.severity, 'alta');

  assert.deepEqual(evaluate(snapshot({ metrics: { ...metrics, diskPercent: 79.9 } }), context()), []);
});

test('load alto es severidad media', () => {
  const findings = evaluate(
    snapshot({ metrics: { ...snapshot().metrics, load1: 8.5 } }),
    context(),
  );
  assert.equal(findings[0]?.key, 'srv:capi1:load');
  assert.equal(findings[0]?.severity, 'media');
});

test('contenedores caídos y cola de deploys', () => {
  const findings = evaluate(
    snapshot({
      apps: [
        { uuid: 'a', name: 'waha1', fqdn: 'x', status: 'running', domain: 'x', number: 1 },
        { uuid: 'b', name: 'waha2', fqdn: 'y', status: 'exited', domain: 'y', number: 2 },
      ],
      openDeployments: 4,
    }),
    context(),
  );
  assert.deepEqual(keys(findings), ['srv:capi1:containers', 'srv:capi1:deploy-queue']);
});

test('anomalía de CPU contra la línea base (z > 3)', () => {
  const findings = evaluate(
    snapshot({ metrics: { ...snapshot().metrics, cpuPercent: 40 } }),
    context({ baseline: () => ({ mean: 10, sd: 2, n: 40 }) }),
  );
  assert.deepEqual(keys(findings), ['srv:capi1:anomaly-cpu']);
});

test('la anomalía no se evalúa con poca muestra o sin desvío', () => {
  const metrics = { ...snapshot().metrics, cpuPercent: 40 };
  assert.deepEqual(evaluate(snapshot({ metrics }), context({ baseline: () => ({ mean: 10, sd: 2, n: 5 }) })), []);
  assert.deepEqual(evaluate(snapshot({ metrics }), context({ baseline: () => ({ mean: 10, sd: 0, n: 40 }) })), []);
});

test('WAHA: DNS roto y HTTP caído generan hallazgos distintos', () => {
  const health: WahaHealth[] = [
    { name: 'waha1', domain: 'a.test', httpOk: false, version: null, engine: null, dnsOk: false, resolved: [], error: 'dns' },
    { name: 'waha2', domain: 'b.test', httpOk: false, version: null, engine: null, dnsOk: true, resolved: ['1.2.3.4'], error: 'timeout' },
  ];
  const findings = evaluate(snapshot(), context({ wahaHealth: new Map([['capi1', health]]) }));
  assert.deepEqual(keys(findings), ['srv:capi1:waha-dns', 'srv:capi1:waha-http']);
  const http = findings.find((f) => f.key === 'srv:capi1:waha-http');
  assert.equal(http?.severity, 'alta');
});

function epService(overrides: Partial<EpService> = {}): EpService {
  return {
    project: 'joel',
    name: 'capi-ops',
    key: 'joel/capi-ops',
    type: 'app',
    host: 'ops.test',
    url: 'https://ops.test',
    enabled: true,
    desired: 1,
    actual: 1,
    state: 'up',
    cpuPercent: 5,
    memBytes: null,
    httpOk: true,
    httpStatus: 200,
    httpMs: 10,
    httpError: null,
    ...overrides,
  };
}

function epSnapshot(overrides: Partial<EpSnapshot> = {}): EpSnapshot {
  return {
    alias: 'ep',
    name: 'EasyPanel',
    url: 'https://panel.test',
    ip: '10.0.0.9',
    reachable: true,
    cpuPercent: 5,
    memUsedBytes: null,
    memTotalBytes: null,
    memPercent: 40,
    diskPercent: 50,
    diskUsedGb: 10,
    diskTotalGb: 20,
    load1: 0.5,
    cores: 4,
    uptimeSeconds: 100,
    updateAvailable: false,
    updateVersion: null,
    services: [],
    lastError: null,
    collectedAt: 0,
    ...overrides,
  };
}

test('EasyPanel: host caído corta la evaluación', () => {
  const findings = evaluateEasyPanel(
    epSnapshot({ reachable: false, lastError: 'econnrefused', services: [epService({ state: 'down' })] }),
    context().thresholds,
    90,
  );
  assert.deepEqual(keys(findings), ['ep:ep:host:down']);
});

test('EasyPanel: actualización pendiente y servicio caído', () => {
  const findings = evaluateEasyPanel(
    epSnapshot({ updateAvailable: true, updateVersion: '2.38.0', services: [epService({ state: 'down', actual: 0 })] }),
    context().thresholds,
    90,
  );
  assert.deepEqual(keys(findings), ['ep:ep:svc:joel/capi-ops:down', 'ep:ep:update']);
});

test('EasyPanel: HTTP caído y CPU alta por servicio', () => {
  const findings = evaluateEasyPanel(
    epSnapshot({ services: [epService({ httpOk: false, httpError: '500', cpuPercent: 95 })] }),
    context().thresholds,
    90,
  );
  assert.deepEqual(keys(findings), ['ep:ep:svc:joel/capi-ops:cpu', 'ep:ep:svc:joel/capi-ops:http']);
});
