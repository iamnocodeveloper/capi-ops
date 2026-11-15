// Diagnóstico de sesiones WAHA por consola, usando la misma lógica que /diag del bot.
// Uso: npm run diag -- <wahaNN|oficina> [sesión] [cuándo] [±ventana]
//   npm run diag -- waha23 plp-3-res 11:30
//   npm run diag -- waha23 plpll-respaldoo "03/11 06:35"
import { loadFleet, loadOffices } from '../src/config.js';
import { probeServer } from '../src/probe.js';
import { findApp } from '../src/installer.js';
import { hasSsh } from '../src/ssh.js';
import {
  cleanLine,
  extractEvents,
  logsWindow,
  logoutEvents,
  networkInfo,
  pickReason,
  reasonInfo,
  relevantLines,
  resolveContainer,
} from '../src/diagnostics.js';
import { listSessions } from '../src/waha.js';
import { fmtArt, parseWhen, windowAround } from '../src/time.js';
import type { ServerSnapshot } from '../src/types.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (!first) {
    console.log('Uso: npm run diag -- <wahaNN|oficina> [sesión] [cuándo] [±ventana]');
    console.log('  npm run diag -- waha23 plp-3-res 11:30');
    console.log('  npm run diag -- Oficina19 norte hoy');
    process.exit(1);
  }

  const offices = loadOffices();
  const clean = (v: string) => v.toLowerCase().replace(/^oficina\s*/, '').trim();
  const officeKey = Object.keys(offices).find((k) => clean(k) === clean(first));
  const target = officeKey ? offices[officeKey]!.instance : first;

  const fleet = loadFleet();
  const snapshots: ServerSnapshot[] = [];
  for (const server of fleet.servers) snapshots.push(await probeServer(server));

  const found = findApp(snapshots, target);
  if (!found) {
    console.error(`No encontré "${target}" en la flota.`);
    process.exit(1);
  }
  const server = fleet.servers.find((s) => s.alias === found.server.alias);
  if (!server) {
    console.error(`Servidor desconocido: ${found.server.alias}`);
    process.exit(1);
  }
  if (!hasSsh(server)) {
    console.error(`SSH no configurado para ${server.alias} (revisá ssh.passwordEnv / ssh.keyPath).`);
    process.exit(1);
  }

  const sessions = await listSessions(found.app.domain, process.env.WAHA_API_KEY ?? '');
  if (sessions === null) {
    console.error('No pude leer las sesiones por la API de WAHA.');
    process.exit(1);
  }

  const rest = argv.slice(1);
  let sessionName: string | undefined;
  if (rest[0] && sessions.some((s) => s.name.toLowerCase() === rest[0]!.toLowerCase())) {
    sessionName = sessions.find((s) => s.name.toLowerCase() === rest[0]!.toLowerCase())!.name;
    rest.shift();
  }

  let window = rest.length ? parseWhen(rest.join(' ')) : parseWhen(undefined);
  const duration = rest.find((part) => /^\d+[mh]$/.test(part));
  if (duration && window.point) window = windowAround(window.point, duration);

  const targets = sessionName
    ? sessions.filter((s) => s.name === sessionName)
    : sessions.filter((s) => s.status === 'FAILED');
  if (!targets.length) {
    console.log('Sin sesiones FAILED. Pasá el nombre de una sesión para diagnosticarla igual.');
    return;
  }

  console.log(`${found.app.name} @ ${server.alias} (${server.ip}) · ventana ${window.label}`);
  const container = await resolveContainer(server, found.app.uuid);
  const net = await networkInfo(server, container);
  console.log(
    `Red: host ${net.hostIp ?? '–'} · contenedor ${net.containerIp ?? '–'} · ${net.proxyVars.join(', ') || 'sin proxy'}`,
  );
  console.log('');

  for (const session of targets) {
    console.log(`== ${session.name} — ${session.status}`);
    const raw = await logsWindow(server, container, { since: window.since, until: window.until });
    const events = extractEvents(raw, session.name);
    const picked = pickReason(events);
    const info = reasonInfo(picked.code);
    console.log(`Motivo: ${info.label}`);
    console.log(`Acción: ${info.action}`);
    if (picked.event?.at) console.log(`Cuándo: ${fmtArt(picked.event.at)}`);
    for (const event of events.slice(-8)) {
      console.log(`  [${event.at ? fmtArt(event.at) : '--'}] ${cleanLine(event.text).slice(0, 180)}`);
    }
    for (const line of relevantLines(raw, session.name, 6)) {
      console.log(`  | ${cleanLine(line).slice(0, 220)}`);
    }
    console.log('');
  }

  const history = await logoutEvents(server, container, { session: sessionName, days: 5 });
  if (history.length) {
    console.log('Historial (5 días):');
    for (const event of history.slice(-20)) {
      console.log(`  ${event.at ? fmtArt(event.at) : '--'}  ${event.code}  ${event.text.slice(0, 120)}`);
    }
  }
}

void main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
