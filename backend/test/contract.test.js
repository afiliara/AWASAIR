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

test('aturan hujan: hujan lebat selalu BAHAYA, walau air belum naik', () => {
  assert.equal(hitungStatus(100, T, null, 5, 'lebat'), 'BAHAYA');      // lebat, air rendah
  assert.equal(hitungStatus(250, T, null, 5, 'lebat'), 'BAHAYA');      // lebat, air tinggi
  assert.equal(hitungStatus(100, T, null, 5, 'sedang'), 'NORMAL');     // sedang, air rendah = aman
  assert.equal(hitungStatus(210, T, null, 5, 'sedang'), 'SIAGA');      // sedang, air di ambang siaga
  assert.equal(hitungStatus(245, T, null, 5, 'sedang'), 'BAHAYA');     // sedang, air di ambang bahaya
  for (const h of ['kering', 'ringan', 'sedang', 'lebat']) {
    assert.equal(hitungStatus(245, T, null, 5, h), 'BAHAYA');          // air bahaya, hujan apa pun
  }
});

test('aturan hujan: setelah hujan lebat reda, status kembali mengikuti air', () => {
  assert.equal(hitungStatus(100, T, 'BAHAYA', 5, 'sedang'), 'NORMAL');
  assert.equal(hitungStatus(210, T, 'BAHAYA', 5, 'ringan'), 'SIAGA');
  assert.equal(hitungStatus(NaN, T, null, 5, 'lebat'), 'ERROR');       // sensor air gagal tetap ERROR
});

test('histeresis kategori hujan: makin basah langsung, makin kering lewat batas + 100', () => {
  assert.equal(kategoriHujan(1400, 'sedang'), 'lebat');
  assert.equal(kategoriHujan(1550, 'lebat'), 'lebat');   // belum lewat 1500 + 100
  assert.equal(kategoriHujan(1600, 'lebat'), 'sedang');
  assert.equal(kategoriHujan(2550, 'sedang'), 'sedang');
  assert.equal(kategoriHujan(2600, 'sedang'), 'ringan');
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
