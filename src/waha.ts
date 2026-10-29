import { promises as dns, setDefaultResultOrder } from 'node:dns';
import type { WahaHealth } from './types.js';

// Muchos hosts resuelven AAAA sin IPv6 usable: sin esto, fetch se queda colgado.
setDefaultResultOrder('ipv4first');

const VERSION_TTL_MS = 60_000;
const DNS_TIMEOUT_MS = 5000;
const CHECK_TIMEOUT_MS = 12_000;
const cache = new Map<string, { at: number; value: WahaHealth }>();

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}

export async function checkDns(domain: string, expectedIp: string): Promise<{ ok: boolean; ips: string[] }> {
  try {
    const ips = await withTimeout(dns.resolve4(domain), DNS_TIMEOUT_MS, 'dns');
    return { ok: ips.includes(expectedIp), ips };
  } catch {
    return { ok: false, ips: [] };
  }
}

export async function checkWahaVersion(
  domain: string,
  apiKey: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; version: string | null; engine: string | null; error: string | null }> {
  try {
    const res = await fetch(`https://${domain}/api/version`, {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, version: null, engine: null, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { version?: string; engine?: string };
    return { ok: true, version: body.version ?? null, engine: body.engine ?? null, error: null };
  } catch (err) {
    return { ok: false, version: null, engine: null, error: (err as Error).message };
  }
}

/** Health de una instancia: DNS + respuesta de /api/version (con cache y watchdog). */
export async function checkWaha(
  name: string,
  domain: string,
  expectedIp: string,
  apiKey: string,
): Promise<WahaHealth> {
  const cached = cache.get(domain);
  if (cached && Date.now() - cached.at < VERSION_TTL_MS) return cached.value;

  const fallback: WahaHealth = {
    name,
    domain,
    dnsOk: false,
    resolved: [],
    httpOk: false,
    version: null,
    engine: null,
    error: 'timeout de comprobación',
  };

  try {
    const value = await withTimeout(doCheckWaha(name, domain, expectedIp, apiKey), CHECK_TIMEOUT_MS, 'waha');
    cache.set(domain, { at: Date.now(), value });
    return value;
  } catch {
    cache.set(domain, { at: Date.now(), value: fallback });
    return fallback;
  }
}

async function doCheckWaha(
  name: string,
  domain: string,
  expectedIp: string,
  apiKey: string,
): Promise<WahaHealth> {
  // 1) HTTP primero: si responde, el DNS obviamente resuelve y el contenedor está vivo.
  const version = await checkWahaVersion(domain, apiKey);
  if (version.ok) {
    return {
      name,
      domain,
      dnsOk: true,
      resolved: [],
      httpOk: true,
      version: version.version,
      engine: version.engine,
      error: null,
    };
  }

  // 2) Si falla, recién ahí resolvemos DNS para saber si el problema es de dominio.
  const dnsResult = await checkDns(domain, expectedIp);
  return {
    name,
    domain,
    dnsOk: dnsResult.ok,
    resolved: dnsResult.ips,
    httpOk: false,
    version: null,
    engine: null,
    error: dnsResult.ok ? (version.error ?? 'sin respuesta HTTP') : 'DNS no apunta al servidor',
  };
}

export async function listSessions(
  domain: string,
  apiKey: string,
  timeoutMs = 8000,
): Promise<Array<{ name: string; status: string; engine?: string }> | null> {
  try {
    const res = await fetch(`https://${domain}/api/sessions?all=true`, {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as Array<{ name: string; status: string; engine?: string }>;
  } catch {
    return null;
  }
}

/** Corre promesas con concurrencia limitada. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (index < items.length) {
      const current = index++;
      const item = items[current] as T;
      out[current] = await fn(item);
    }
  });
  await Promise.all(workers);
  return out;
}
