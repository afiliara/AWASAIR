import test from 'node:test';
import assert from 'node:assert/strict';
import { hitungStatus, kategoriHujan, parseData, validateCmd } from '../src/contract.js';

const T = { siaga: 200, bahaya: 240 };

test('status naik langsung di ambang', () => {
  assert.equal(hitungStatus(199.9, T), 'NORMAL');
  assert.equal(hitungStatus(200, T), 'SIAGA');
  assert.equal(hitungStatus(239.9, T), 'SIAGA');
  assert.equal(hitungStatus(240, T), 'BAHAYA');
});

test('histeresis: turun harus lewat ambang - 5 cm', () => {
  assert.equal(hitungStatus(238, T, 'BAHAYA'), 'BAHAYA');
  assert.equal(hitungStatus(234.9, T, 'BAHAYA'), 'SIAGA');
  assert.equal(hitungStatus(197, T, 'SIAGA'), 'SIAGA');
  assert.equal(hitungStatus(194.9, T, 'SIAGA'), 'NORMAL');
});

test('turun dari BAHAYA berjalan bertahap', () => {
  assert.equal(hitungStatus(150, T, 'BAHAYA'), 'NORMAL');
  assert.equal(hitungStatus(198, T, 'BAHAYA'), 'SIAGA');
});

test('level tidak valid menjadi ERROR, bukan aman', () => {
  assert.equal(hitungStatus(NaN, T), 'ERROR');
  assert.equal(hitungStatus(undefined, T), 'ERROR');
});

test('kategori hujan: nilai makin kecil makin basah', () => {
  assert.equal(kategoriHujan(4095), 'kering');
  assert.equal(kategoriHujan(3000), 'ringan');
  assert.equal(kategoriHujan(2000), 'sedang');
  assert.equal(kategoriHujan(500), 'lebat');
});

test('parseData: menerima payload sah dan menolak yang rusak', () => {
  const ok = parseData('{"level":245.3,"jarak":54.7,"adc":1800,"hujan":"sedang","status":"BAHAYA"}');
  assert.equal(ok.level, 245.3);
  assert.equal(ok.status, 'BAHAYA');
  assert.equal(parseData('bukan json'), null);
  assert.equal(parseData('{"level":10,"status":"AMAN"}'), null);
  assert.equal(parseData('{"status":"NORMAL"}'), null); // tanpa level
  const err = parseData('{"status":"ERROR","adc":4000}');
  assert.equal(err.level, null);
  assert.equal(err.status, 'ERROR');
});

test('validateCmd', () => {
  assert.deepEqual(validateCmd({ mute: true }), { ok: true, cmd: { mute: true } });
  assert.equal(validateCmd({ mute: 'ya' }).ok, false);
  assert.equal(validateCmd({ siaga: 250, bahaya: 240 }).ok, false);
  assert.equal(validateCmd({}).ok, false);
  assert.equal(validateCmd(null).ok, false);
});
