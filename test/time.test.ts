import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtArt, fromZone, parseWhen, windowAround } from '../src/time.js';

const TZ = 'America/Argentina/Buenos_Aires';
// 2026-11-15T14:30Z == 11:30 en ART (UTC-3, sin horario de verano).
const NOW = Date.UTC(2026, 10, 15, 14, 30, 0);

test('fromZone convierte ART a UTC', () => {
  assert.equal(fromZone(2026, 11, 3, 11, 43, TZ).toISOString(), '2026-11-03T14:43:00.000Z');
  assert.equal(fromZone(2026, 1, 1, 0, 0, TZ).toISOString(), '2026-01-01T03:00:00.000Z');
});

test('fmtArt formatea en la zona indicada', () => {
  assert.equal(fmtArt(Date.UTC(2026, 10, 15, 14, 30), TZ), '15/11 11:30:00');
});

test('sin argumento devuelve las últimas 2 horas', () => {
  const w = parseWhen('', NOW, TZ);
  assert.equal(w.since.getTime(), NOW - 2 * 3_600_000);
  assert.equal(w.until.getTime(), NOW);
  assert.equal(w.label, 'últimas 2 h');
});

test('duraciones 2h y 30m', () => {
  assert.equal(parseWhen('2h', NOW, TZ).since.getTime(), NOW - 2 * 3_600_000);
  assert.equal(parseWhen('30m', NOW, TZ).since.getTime(), NOW - 30 * 60_000);
});

test('hora puntual abre una ventana de ±10 minutos', () => {
  const w = parseWhen('11:30', NOW, TZ);
  assert.equal(w.point?.toISOString(), '2026-11-15T14:30:00.000Z');
  assert.equal(w.since.toISOString(), '2026-11-15T14:20:00.000Z');
  assert.equal(w.until.toISOString(), '2026-11-15T14:40:00.000Z');
});

test('fecha con hora usa la zona configurada', () => {
  const w = parseWhen('03/11 11:43', NOW, TZ);
  assert.equal(w.point?.toISOString(), '2026-11-03T14:43:00.000Z');
});

test('ayer cubre el día calendario completo', () => {
  const w = parseWhen('ayer', NOW, TZ);
  assert.equal(w.since.toISOString(), '2026-11-14T03:00:00.000Z');
  assert.equal(w.until.toISOString(), '2026-11-15T03:00:00.000Z');
  assert.equal(w.label, 'ayer');
});

test('una entrada inválida lanza un error claro', () => {
  assert.throws(() => parseWhen('pronto', NOW, TZ), /no entendí/);
});

test('windowAround centra la ventana en el instante', () => {
  const point = new Date('2026-11-15T14:30:00.000Z');
  const w = windowAround(point, '30m');
  assert.equal(w.since.toISOString(), '2026-11-15T14:00:00.000Z');
  assert.equal(w.until.toISOString(), '2026-11-15T15:00:00.000Z');
  assert.throws(() => windowAround(point, 'x'), /ventana inválida/);
});
