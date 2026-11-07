import { CONFIG } from './config.js';
import { api } from './api.js';
import { connectMqtt } from './mqtt-client.js';

const $ = (id) => document.getElementById(id);
const HUJAN_IDX = { kering: 0, ringan: 1, sedang: 2, lebat: 3 };
const HUJAN_NAMA = ['Kering', 'Ringan', 'Sedang', 'Lebat'];

// ---------- State ----------
const S = {
  latest: null, // { level, jarak, adc, hujan, status, at }  `at` = waktu terima di browser
  status: null,
  online: null,
  ack: null,
  mqttUp: false,
  apiUp: null, // null = belum dicoba
  events: [],
  rangeMin: 60,
};
let mq = null;
let pending = null; // { cmd, timer } menunggu ack
let formDirty = false;

const thresholds = () => ({
  siaga: S.ack?.siaga ?? CONFIG.defaultSiaga,
  bahaya: S.ack?.bahaya ?? CONFIG.defaultBahaya,
});

// ---------- Tampilan status ----------
// Data yang hilang, basi, atau error TIDAK boleh terlihat seperti "aman".
function view() {
  const l = S.latest;
  if (!l) return { cls: 'unknown', text: 'TIDAK ADA DATA', note: 'Menunggu data dari sensor' };
  const age = (Date.now() - l.at) / 1000;
  if (S.online === 'offline') return { cls: 'unknown', text: 'SENSOR OFFLINE', note: 'Perangkat terputus. Nilai terakhir bisa sudah tidak berlaku.' };
  if (age > CONFIG.staleSeconds) return { cls: 'unknown', text: 'DATA BASI', note: `Tidak ada data baru selama ${fmtAge(age)}` };
  if (l.status === 'ERROR') return { cls: 'bahaya', text: 'SENSOR ERROR', note: 'Pembacaan ketinggian gagal. Periksa sensor.' };
  const note = { NORMAL: 'Ketinggian air aman', SIAGA: 'Waspada, air mulai tinggi', BAHAYA: 'Air sangat tinggi, segera bertindak' }[l.status];
  return { cls: l.status.toLowerCase(), text: l.status, note };
}

function fmtAge(sec) {
  if (sec < 60) return `${Math.round(sec)} dtk`;
  if (sec < 3600) return `${Math.floor(sec / 60)} mnt`;
  return `${Math.floor(sec / 3600)} jam`;
}
const fmtClock = (ts) => new Date(ts).toLocaleString('id-ID', { hour12: false });
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('id-ID', { hour12: false });

function render() {
  const v = view();
  const l = S.latest;
  const { siaga, bahaya } = thresholds();

  $('hero').className = `hero st-${v.cls}`;
  $('statusText').textContent = v.text;
  $('statusNote').textContent = v.note;
  $('levelValue').textContent = l?.level != null ? l.level.toFixed(1) : '–';

  // Kewaspadaan: masih NORMAL, tetapi mendekati Siaga dan hujan lebat.
  const alertBox = $('alertBox');
  const waspada = l && v.cls === 'normal' && l.level != null && l.hujan === 'lebat' && l.level >= siaga - CONFIG.waspadaMarginCm;
  alertBox.hidden = !waspada;
  if (waspada) alertBox.textContent = 'Kewaspadaan: hujan lebat dan air mendekati ambang Siaga.';

  // Gauge
  const max = bahaya * 1.25;
  const pct = (x) => `${Math.min(100, Math.max(0, (x / max) * 100))}%`;
  const fill = $('gaugeFill');
  fill.style.width = l?.level != null ? pct(l.level) : '0';
  fill.className = `gauge-fill ${v.cls === 'siaga' ? 'siaga' : v.cls === 'bahaya' ? 'bahaya' : ''}`;
  $('markSiaga').style.left = pct(siaga);
  $('markBahaya').style.left = pct(bahaya);

  $('hujanText').textContent = l?.hujan ? l.hujan[0].toUpperCase() + l.hujan.slice(1) : '–';
  $('adcText').textContent = l?.adc != null ? `ADC ${l.adc}` : 'ADC –';
  $('jarakText').textContent = l?.jarak != null ? l.jarak.toFixed(1) : '–';
  $('ageText').textContent = l ? `${fmtAge((Date.now() - l.at) / 1000)} lalu` : '–';
  $('timeText').textContent = l ? fmtClock(l.at) : '–';

  let buzzer = '–';
  if (S.ack?.mute) buzzer = 'Dibisukan';
  else if (l) buzzer = { SIAGA: 'Putus-putus', BAHAYA: 'Kontinu' }[l.status] ?? 'Mati';
  $('buzzerText').textContent = buzzer;

  // Indikator koneksi
  const dot = $('connDot');
  if (!S.mqttUp) { dot.className = 'dot dot-off'; $('connText').textContent = 'Terputus dari broker'; }
  else if (S.apiUp === false) { dot.className = 'dot dot-warn'; $('connText').textContent = 'Live. Riwayat tidak tersedia'; }
  else { dot.className = 'dot dot-on'; $('connText').textContent = 'Terhubung'; }
}

// ---------- Peristiwa ----------
function renderEvents() {
  const build = (ul, items) => {
    ul.replaceChildren();
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Belum ada peristiwa.';
      ul.append(li);
      return;
    }
    for (const e of items) {
      const li = document.createElement('li');
      const tag = document.createElement('span');
      tag.className = `tag ${e.value}`;
      tag.textContent = e.value.toUpperCase();
      const msg = document.createElement('span');
      msg.textContent = e.message;
      const t = document.createElement('time');
      t.textContent = fmtClock(e.ts);
      li.append(tag, msg, t);
      ul.append(li);
    }
  };
  build($('recentEvents'), S.events.slice(0, 5));
  build($('allEvents'), S.events);
}

async function loadEvents() {
  try {
    S.events = await api.events(50);
    S.apiUp = true;
    renderEvents();
  } catch {
    S.apiUp = false;
  }
  render();
}

// Cadangan bila backend mati: catat perubahan secara lokal.
function localEvent(type, value, prev, message) {
  S.events.unshift({ ts: Date.now(), type, value, prev, message });
  S.events = S.events.slice(0, 50);
  renderEvents();
}

// ---------- Grafik ----------
let chartLevel = null;
let chartHujan = null;

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function ensureCharts() {
  if (chartLevel || !window.Chart) return;
  const grid = css('--line');
  const muted = css('--muted');
  const timeTick = { color: muted, maxTicksLimit: 6, callback: (v) => fmtTime(v) };
  const base = {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    parsing: false,
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    plugins: { legend: { labels: { color: muted, boxWidth: 12 } } },
  };
  const xScale = { type: 'linear', ticks: timeTick, grid: { color: grid } };

  chartLevel = new Chart($('chartLevel'), {
    type: 'line',
    data: {
      datasets: [
        { label: 'Level', data: [], borderColor: css('--accent'), borderWidth: 2, pointRadius: 0, tension: 0.2 },
        { label: 'Siaga', data: [], borderColor: css('--siaga'), borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0 },
        { label: 'Bahaya', data: [], borderColor: css('--bahaya'), borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0 },
      ],
    },
    options: {
      ...base,
      scales: { x: xScale, y: { ticks: { color: muted }, grid: { color: grid }, title: { display: true, text: 'cm', color: muted } } },
    },
  });

  chartHujan = new Chart($('chartHujan'), {
    type: 'line',
    data: { datasets: [{ label: 'Hujan', data: [], borderColor: css('--normal'), borderWidth: 2, pointRadius: 0, stepped: true }] },
    options: {
      ...base,
      plugins: { legend: { display: false } },
      scales: {
        x: xScale,
        y: { min: 0, max: 3, ticks: { stepSize: 1, color: muted, callback: (v) => HUJAN_NAMA[v] ?? '' }, grid: { color: grid } },
      },
    },
  });
}

function setChartData(rows) {
  const { siaga, bahaya } = thresholds();
  const lv = rows.filter((r) => r.level != null).map((r) => ({ x: r.ts, y: r.level }));
  const hj = rows.filter((r) => r.hujan).map((r) => ({ x: r.ts, y: HUJAN_IDX[r.hujan] }));
  const x0 = Date.now() - S.rangeMin * 60_000;
  const x1 = Date.now();
  chartLevel.data.datasets[0].data = lv;
  chartLevel.data.datasets[1].data = [{ x: x0, y: siaga }, { x: x1, y: siaga }];
  chartLevel.data.datasets[2].data = [{ x: x0, y: bahaya }, { x: x1, y: bahaya }];
  chartHujan.data.datasets[0].data = hj;
  for (const c of [chartLevel, chartHujan]) {
    c.options.scales.x.min = x0;
    c.options.scales.x.max = x1;
    c.update();
  }
  $('chartNote').textContent = lv.length ? '' : 'Belum ada data pada rentang ini.';
}

async function loadHistory() {
  ensureCharts();
  if (!chartLevel) return;
  try {
    setChartData(await api.readings(S.rangeMin));
    S.apiUp = true;
  } catch {
    S.apiUp = false;
    $('chartNote').textContent = 'Riwayat tidak bisa dimuat. Backend belum berjalan?';
  }
  render();
}

function pushLivePoint(l) {
  if (!chartLevel) return;
  const cutoff = Date.now() - S.rangeMin * 60_000;
  const add = (chart, y) => {
    const ds = chart.data.datasets[0].data;
    ds.push({ x: l.at, y });
    while (ds.length && ds[0].x < cutoff) ds.shift();
    chart.options.scales.x.min = cutoff;
    chart.options.scales.x.max = l.at;
  };
  if (l.level != null) add(chartLevel, l.level);
  if (l.hujan) add(chartHujan, HUJAN_IDX[l.hujan]);
  const { siaga, bahaya } = thresholds();
  chartLevel.data.datasets[1].data = [{ x: cutoff, y: siaga }, { x: l.at, y: siaga }];
  chartLevel.data.datasets[2].data = [{ x: cutoff, y: bahaya }, { x: l.at, y: bahaya }];
  chartLevel.update();
  chartHujan.update();
}

// ---------- Pengaturan ----------
function fillForm() {
  const { siaga, bahaya } = thresholds();
  if (!formDirty) {
    $('inSiaga').value = siaga;
    $('inBahaya').value = bahaya;
  }
  if (S.ack) $('inMute').checked = !!S.ack.mute;
}

async function send(cmd) {
  if (mq?.connected) return mq.publishCmd(cmd);
  return api.sendCmd(cmd);
}

function waitAck(cmd) {
  clearTimeout(pending?.timer);
  $('saveStatus').textContent = 'Terkirim. Menunggu konfirmasi perangkat…';
  pending = {
    cmd,
    timer: setTimeout(() => {
      pending = null;
      $('saveStatus').textContent = 'Perangkat belum mengonfirmasi. Nilai di atas masih yang lama.';
      $('btnSave').disabled = false;
    }, 8000),
  };
}

function checkAckAgainstPending() {
  if (!pending || !S.ack) return;
  if (Object.entries(pending.cmd).every(([k, v]) => S.ack[k] === v)) {
    clearTimeout(pending.timer);
    pending = null;
    formDirty = false;
    $('saveStatus').textContent = 'Perangkat mengonfirmasi pengaturan baru.';
    $('btnSave').disabled = false;
    fillForm();
  }
}

function setupForm() {
  const err = $('formError');
  for (const id of ['inSiaga', 'inBahaya']) $(id).addEventListener('input', () => { formDirty = true; });

  $('settingsForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const siaga = Number($('inSiaga').value);
    const bahaya = Number($('inBahaya').value);
    err.hidden = true;
    if (!Number.isFinite(siaga) || !Number.isFinite(bahaya) || siaga <= 0 || bahaya <= 0) {
      err.textContent = 'Isi kedua ambang dengan angka positif.';
      err.hidden = false;
      return;
    }
    if (siaga >= bahaya) {
      err.textContent = 'Ambang Siaga harus lebih kecil dari Bahaya.';
      err.hidden = false;
      return;
    }
    const cmd = { siaga, bahaya };
    $('btnSave').disabled = true;
    try {
      await send(cmd);
      waitAck(cmd);
    } catch (e) {
      $('saveStatus').textContent = `Gagal mengirim: ${e.message}`;
      $('btnSave').disabled = false;
    }
  });

  $('inMute').addEventListener('change', async (ev) => {
    const cmd = { mute: ev.target.checked };
    try {
      await send(cmd);
      waitAck(cmd);
    } catch (e) {
      $('saveStatus').textContent = `Gagal mengirim: ${e.message}`;
      ev.target.checked = !!S.ack?.mute;
    }
  });
}

// ---------- Tab dan rentang ----------
function setupTabs() {
  const tabs = document.querySelectorAll('.tabs button');
  const show = (name) => {
    for (const b of tabs) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== `tab-${name}`;
    if (name === 'grafik') loadHistory();
  };
  for (const b of tabs) b.addEventListener('click', () => show(b.dataset.tab));

  $('range').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.rangeMin = Number(b.dataset.min);
    for (const x of $('range').children) x.classList.toggle('on', x === b);
    loadHistory();
  });
}

// ---------- MQTT ----------
function startLive() {
  mq = connectMqtt({
    onConnection(up) {
      S.mqttUp = up;
      render();
    },
    onData(d) {
      S.latest = { level: d.level ?? null, jarak: d.jarak ?? null, adc: d.adc ?? null, hujan: d.hujan ?? null, status: d.status, at: Date.now() };
      render();
      pushLivePoint(S.latest);
    },
    onStatus(s) {
      const prev = S.status;
      S.status = s;
      if (prev !== null && prev !== s) {
        if (S.apiUp) setTimeout(loadEvents, 400);
        else localEvent('status', s, prev, `Status berubah ${prev} → ${s}`);
      }
      render();
    },
    onOnline(o) {
      const prev = S.online;
      S.online = o;
      if (prev !== null && prev !== o) {
        if (S.apiUp) setTimeout(loadEvents, 400);
        else localEvent('online', o, prev, o === 'online' ? 'Sensor terhubung kembali' : 'Sensor offline');
      }
      render();
    },
    onAck(a) {
      S.ack = a;
      fillForm();
      checkAckAgainstPending();
      render();
    },
  });
}

// ---------- Mulai ----------
async function boot() {
  $('lokasi').textContent = CONFIG.lokasi;
  setupTabs();
  setupForm();
  fillForm();
  render();
  renderEvents();
  startLive();

  // Keadaan awal dari backend, supaya halaman langsung terisi tanpa menunggu publish berikutnya.
  try {
    const st = await api.state();
    S.apiUp = true;
    if (!S.latest && st.latest) S.latest = { ...st.latest, at: Date.now() - (st.ageSeconds ?? 0) * 1000 };
    S.status ??= st.status;
    S.online ??= st.online;
    S.ack ??= st.ack;
    fillForm();
  } catch {
    S.apiUp = false;
  }
  await loadEvents();
  render();
  setInterval(render, 1000); // memperbarui umur data dan mendeteksi data basi
}

boot();
