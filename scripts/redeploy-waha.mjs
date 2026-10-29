import { readFileSync, writeFileSync } from 'node:fs';

const parseEnv = (file) => {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
};

const env = parseEnv('.env');
const fleet = JSON.parse(readFileSync('config/servers.json', 'utf8'));
const srv = fleet.servers.find((s) => s.alias === 'capi4');
const token = env[srv.tokenEnv];
const url = srv.url;

let seq = 1;
const rpc = async (method, params) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: seq++, method, params }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  const body = text.trim().startsWith('event:') || text.trim().startsWith('data:')
    ? JSON.parse(text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).pop())
    : JSON.parse(text);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return body;
};

const call = async (name, args = {}) => {
  const body = await rpc('tools/call', { name, arguments: args });
  if (body.error) throw new Error(body.error.message);
  const text = (body.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (body.result?.isError) throw new Error(text);
  return JSON.parse(text);
};

await rpc('initialize', {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'redeploy', version: '1' },
});

const targets = [];
for (const n of [46, 47, 48, 49, 50, 51]) targets.push(`waha${n}`);

const apps = (await call('list_applications', { per_page: 100 })).data ?? [];
const selected = targets
  .map((name) => apps.find((a) => a.name === name))
  .filter(Boolean)
  .map((a) => ({ name: a.name, uuid: a.uuid }));

console.log('apps:', selected.map((a) => `${a.name}=${a.uuid}`).join(' '));

const results = [];
for (const app of selected) {
  try {
    const res = await call('deploy', { uuid: app.uuid });
    results.push({ ...app, deployment: res?.data?.deployment_uuid ?? null, status: 'queued', error: null });
    console.log(`deploy ${app.name} -> ${res?.data?.deployment_uuid}`);
  } catch (err) {
    results.push({ ...app, deployment: null, status: 'failed', error: err.message });
    console.log(`deploy ${app.name} ERROR ${err.message}`);
  }
}

const deadline = Date.now() + 12 * 60_000;
let pending = results.filter((r) => r.deployment && r.status === 'queued');

while (pending.length && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 6000));
  const next = [];
  for (const item of pending) {
    try {
      const dep = await call('get_deployment', { uuid: item.deployment });
      const data = dep?.data;
      const status = Array.isArray(data) ? data[0]?.status : data?.status;
      if (status) item.status = status;
      if (status === 'finished' || status === 'failed' || status === 'cancelled') {
        console.log(`${item.name}: ${status}`);
      } else {
        next.push(item);
      }
    } catch (err) {
      console.log(`${item.name}: poll error ${err.message}`);
      next.push(item);
    }
  }
  pending = next;
}

for (const item of pending) item.status = 'timeout';

writeFileSync('redeploy-result.json', JSON.stringify(results, null, 2));
console.log('RESULT', JSON.stringify(results.map((r) => `${r.name}:${r.status}`)));
