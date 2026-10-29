import { loadFleet } from '../dist/config.js';
import { probeServer } from '../dist/probe.js';
import { checkWaha, mapLimit } from '../dist/waha.js';
import { appendFileSync, rmSync } from 'node:fs';

const LOG = 'inventory-send.log';
rmSync(LOG, { force: true });
const log = (l) => appendFileSync(LOG, `${l}\n`);

const TOKEN = process.env.TG_TOKEN;
const CHAT = process.env.TG_CHAT ?? '6991551082';
if (!TOKEN) {
  log('falta TG_TOKEN');
  process.exit(1);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pad = (t, w) => (t.length >= w ? t.slice(0, w) : t + ' '.repeat(w - t.length));
function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : pad(c, widths[i] ?? c.length))).join('  ').trimEnd();
  return [line(headers), ...rows.map((r) => line(r.map((c) => c ?? '')))].join('\n');
}

const fleet = loadFleet();
const snaps = [];
for (const s of fleet.servers) snaps.push(await probeServer(s));

const tasks = [];
for (const snap of snaps) for (const app of snap.apps) if (app.number !== null && app.domain) tasks.push({ alias: snap.alias, name: app.name, domain: app.domain, ip: snap.ip });
const healthResults = await mapLimit(tasks, 16, (t) => checkWaha(t.name, t.domain, t.ip, process.env.WAHA_API_KEY ?? ''));
const healthByAlias = new Map();
healthResults.forEach((h, i) => {
  const alias = tasks[i].alias;
  const list = healthByAlias.get(alias) ?? [];
  list.push(h);
  healthByAlias.set(alias, list);
});

let total = 0;
const blocks = [];
for (const snap of snaps) {
  const apps = snap.apps.filter((a) => a.number !== null && a.domain).sort((a, b) => a.number - b.number);
  if (!apps.length) continue;
  total += apps.length;
  const byName = new Map((healthByAlias.get(snap.alias) ?? []).map((h) => [h.name, h]));
  let ok = 0;
  let noDns = 0;
  const rows = apps.map((app) => {
    const h = byName.get(app.name);
    let web = '?';
    if (h) {
      if (h.httpOk) { web = 'ok'; ok++; }
      else if (!h.dnsOk) { web = 'sin dns'; noDns++; }
      else web = 'sin http';
    }
    return [app.name, app.status.startsWith('running') ? 'up' : app.status, web, app.domain];
  });
  const footer = `${apps.length} instancias · ${ok} responden${noDns ? ` · ${noDns} sin DNS` : ''}`;
  blocks.push([`<b>${esc(snap.name)}</b> — ${snap.alias} (${snap.ip})`, `<pre>${esc(table(rows, ['instancia', 'cont.', 'web', 'dominio']))}</pre>`, esc(footer)].join('\n'));
}

async function send(text) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
  });
  const body = await res.json();
  log(`send ok=${body.ok} id=${body.result?.message_id ?? '-'} ${body.ok ? '' : JSON.stringify(body)}`);
}

let buffer = `<b>Inventario WAHA</b> — ${total} instancias en ${snaps.length} servidores`;
for (const block of blocks) {
  if ((buffer + '\n' + block).length > 3900) {
    await send(buffer);
    buffer = block;
  } else {
    buffer = `${buffer}\n${block}`;
  }
}
if (buffer.trim()) await send(buffer);
log('DONE');
