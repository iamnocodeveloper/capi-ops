/**
 * Chequeo de las funciones puras del alta de servidores.
 * No usa framework: corre con `npm run check:provision` y termina en 0 (ok) o 1 (falló).
 */
import {
  buildFleetEntry,
  defaultAlias,
  envTokenName,
  formatInstallerProgress,
  isCoolifyToken,
  isIpv4,
  nextWahaRange,
  parseInstallerLog,
  parseTokenOutput,
  WAHA_RANGE_SIZE,
} from '../src/provision.js';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `esperado ${e}, obtenido ${a}`);
}

// ── nextWahaRange ────────────────────────────────────────────────────────────
eq('rango sin servidores', nextWahaRange([]), [1, WAHA_RANGE_SIZE]);
eq('rango tras [1,10]', nextWahaRange([[1, 10]]), [11, 20]);
eq('rango tras varios', nextWahaRange([[1, 10], [11, 20]]), [21, 30]);
eq('rango con orden mezclado', nextWahaRange([[21, 30], [1, 10]]), [31, 40]);
eq('rango ignora inválidos', nextWahaRange([[Number.NaN, Number.NaN]]), [1, WAHA_RANGE_SIZE]);

// ── envTokenName / buildFleetEntry ───────────────────────────────────────────
eq('tokenEnv de capi5', envTokenName('capi5'), 'CAPI5_TOKEN');
eq('tokenEnv sanea símbolos', envTokenName('sr-v.1'), 'SR_V_1_TOKEN');

const entry = buildFleetEntry({
  alias: 'capi5',
  ip: '203.0.113.10',
  token: '12|secreto',
  projectUuid: 'proj',
  serverUuid: 'srv',
  destinationUuid: 'dst',
  wahaRange: [11, 20],
});
eq('fleetEntry url', entry.url, 'http://203.0.113.10:8000/mcp');
eq('fleetEntry alias', entry.alias, 'capi5');
eq('fleetEntry name por defecto', entry.name, 'capi5');
eq('fleetEntry tokenEnv por defecto', entry.tokenEnv, 'CAPI5_TOKEN');
eq('fleetEntry entorno por defecto', entry.environmentName, 'production');
eq('fleetEntry wahaRange', entry.wahaRange, [11, 20]);
eq('fleetEntry token', entry.token, '12|secreto');

const entryCustom = buildFleetEntry({
  alias: 'nodo',
  name: 'Nodo Uno',
  ip: '10.0.0.1',
  port: 9000,
  token: 'x',
  tokenEnv: 'NODO_TOKEN',
  projectUuid: 'p',
  environmentName: 'staging',
  serverUuid: 's',
  destinationUuid: 'd',
  wahaRange: [1, 10],
});
eq('fleetEntry puerto custom', entryCustom.url, 'http://10.0.0.1:9000/mcp');
eq('fleetEntry name custom', entryCustom.name, 'Nodo Uno');
eq('fleetEntry tokenEnv custom', entryCustom.tokenEnv, 'NODO_TOKEN');
eq('fleetEntry entorno custom', entryCustom.environmentName, 'staging');

// ── isCoolifyToken / parseTokenOutput ────────────────────────────────────────
const TOKEN = `12|${'a'.repeat(40)}`;
check('token válido', isCoolifyToken(TOKEN));
check('token sin secreto', !isCoolifyToken('12|'));
check('token sin id', !isCoolifyToken(`x|${'a'.repeat(40)}`));
check('token corto', !isCoolifyToken('12|abc'));

eq('parseTokenOutput limpio', parseTokenOutput(`TOKENOUT:${TOKEN}`), TOKEN);
eq(
  'parseTokenOutput entre ruido',
  parseTokenOutput(`Psy Shell v0.11\nTOKENOUT:${TOKEN}\nbye`),
  TOKEN,
);
eq('parseTokenOutput sin marca', parseTokenOutput('nada por acá'), null);
eq('parseTokenOutput token inválido', parseTokenOutput('TOKENOUT:roto'), null);

// ── isIpv4 / defaultAlias ────────────────────────────────────────────────────
check('ipv4 válida', isIpv4('203.0.113.10'));
check('ipv4 fuera de rango', !isIpv4('256.1.1.1'));
check('ipv4 con letras', !isIpv4('203.0.113.x'));
check('ipv4 con puerto', !isIpv4('203.0.113.10:22'));
eq('alias por defecto vacío', defaultAlias([]), 'capi1');
eq('alias por defecto con capi4', defaultAlias(['capi1', 'capi4']), 'capi5');
eq('alias por defecto ignora otros', defaultAlias(['ep', 'capi2']), 'capi3');

// ── parseInstallerLog / formatInstallerProgress ──────────────────────────────
const conPaso = parseInstallerLog('[+] 9/9 Done. Coolify installed\n');
check('instalador paso 9/9 terminado', conPaso.done);
eq('instalador paso detectado', conPaso.step, 9);

const conContenedores = parseInstallerLog(
  ['coolify', 'coolify-db', 'coolify-redis', 'coolify-sentinel', 'coolify-proxy'].join('\n'),
);
check('instalador contenedores completos', conContenedores.done);
eq('instalador contenedores listados', conContenedores.containers.length, 5);
eq('instalador sin faltantes', conContenedores.missing, []);

const parcial = parseInstallerLog('paso 4/9\ncoolify-db\ncoolify-redis\n');
check('instalador parcial no terminado', !parcial.done);
eq('instalador parcial paso', parcial.step, 4);
check('instalador parcial lista faltantes', parcial.missing.includes('coolify-proxy'));

check('progreso incluye el paso', formatInstallerProgress(conPaso).includes('9/9'));
check('progreso marca listo', formatInstallerProgress(conPaso).includes('listo'));

// ── resultado ────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`❌ check:provision — ${failures.length} fallo(s) de ${passed + failures.length}`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✅ check:provision — ${passed} chequeos ok`);
process.exit(0);
