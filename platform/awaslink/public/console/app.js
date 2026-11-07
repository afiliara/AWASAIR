// AwasLink - frontend dashboard real-time (tanpa framework)
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
let ME = { admin: false };
let cleanup = [];
const listeners = new Set(); // fungsi(msg) yang menerima pesan WebSocket

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (ts) => (ts ? new Date(ts).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'medium' }) : '-');
const ago = (ts) => {
  if (!ts) return 'belum ada data';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return Math.max(0, Math.round(s)) + ' detik lalu';
  if (s < 3600) return Math.round(s / 60) + ' menit lalu';
  if (s < 86400) return Math.round(s / 3600) + ' jam lalu';
  return Math.round(s / 86400) + ' hari lalu';
};
const uid = () => 'x' + Math.random().toString(36).slice(2, 8);
const ls = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2800); }

async function api(method, url, body) {
  const r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
  if (!r.ok) { const e = new Error(data?.error || 'HTTP ' + r.status); e.status = r.status; throw e; }
  return data;
}

// Warna status: NORMAL hijau, SIAGA kuning, BAHAYA merah (bisa diganti lewat opsi widget "colors")
function statusClass(v, colors) {
  const map = Object.fromEntries(String(colors || 'NORMAL:ok,SIAGA:warn,BAHAYA:danger,AMAN:ok,WASPADA:warn').split(',').map((p) => p.split(':').map((s) => s.trim().toUpperCase())));
  return (map[String(v ?? '').toUpperCase()] || '').toLowerCase();
}

// ---------------------------------------------------------------------------
// WebSocket real-time
// ---------------------------------------------------------------------------
let ws; let wsRetry = 1000;
function connectWs() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { wsRetry = 1000; $('#ws').className = 'live on'; $('#ws').textContent = 'live'; };
  ws.onclose = () => { $('#ws').className = 'live'; $('#ws').textContent = 'offline'; setTimeout(connectWs, wsRetry); wsRetry = Math.min(wsRetry * 2, 15000); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'event') notify(m);
    if (m.t === 'error') toast(m.msg);
    if (m.t === 'pending') toast('Perintah terkirim, menunggu konfirmasi (ack) dari alat…');
    if (m.t === 'ack') toast('Alat mengonfirmasi pengaturan baru');
    if (m.t === 'ack-timeout') toast('Alat belum mengonfirmasi perintah. Pastikan perangkat online.');
    listeners.forEach((fn) => fn(m));
  };
}
function wsWrite(d, k, v) {
  if (!ME.admin) return toast('Login admin untuk mengontrol perangkat');
  if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'write', d, k, v }));
  else api('POST', `/api/devices/${d}/write`, { key: k, value: v }).catch((e) => toast(e.message));
}
function listen(fn) { listeners.add(fn); cleanup.push(() => listeners.delete(fn)); }

// Notifikasi browser + bunyi untuk event penting
function beep(times = 3) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.25, ctx.currentTime + i * 0.35); g.gain.setValueAtTime(0, ctx.currentTime + i * 0.35 + 0.2);
      o.start(ctx.currentTime + i * 0.35); o.stop(ctx.currentTime + i * 0.35 + 0.22);
    }
  } catch {}
}
function notify(m) {
  const { ev, device } = m;
  if (ev.level === 'info') return;
  if (ev.level === 'critical' && ls.get('sound', '1') === '1') beep();
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(`${ev.level === 'critical' ? '🚨' : '⚠️'} ${device}`, { body: ev.message, icon: '/console/icon.svg', tag: 'awas-' + ev.device_id }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function loadMe() {
  ME = await api('GET', '/api/me');
  $('#auth').innerHTML = ME.admin
    ? `<button class="btn sm" id="logout">Keluar (${esc(ME.user)})</button>`
    : '<button class="btn sm primary" id="login">Login admin</button>';
  document.querySelectorAll('.admin-only').forEach((e) => (e.hidden = !ME.admin));
  $('#logout')?.addEventListener('click', async () => { await api('POST', '/api/logout'); location.reload(); });
  $('#login')?.addEventListener('click', showLogin);
}
function showLogin() {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<form class="card modal"><h3>Login admin AwasLink</h3>
    <div class="f"><label>Username</label><input type="text" name="username" autocomplete="username" required></div>
    <div class="f"><label>Password</label><input type="password" name="password" autocomplete="current-password" required></div>
    <p class="hint" id="err"></p>
    <div class="row"><span class="spacer"></span><button type="button" class="btn" id="cancel">Batal</button><button class="btn primary">Masuk</button></div></form>`;
  document.body.appendChild(bg); bg.querySelector('input').focus();
  $('#cancel', bg).onclick = () => bg.remove();
  bg.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/login', Object.fromEntries(new FormData(e.target))); location.reload(); }
    catch (err) { $('#err', bg).textContent = err.message; }
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function render() {
  cleanup.forEach((f) => f()); cleanup = [];
  const p = location.hash.replace(/^#\/?/, '').split('/');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.r === (p[0] || 'home') || (p[0] === 'd' && a.dataset.r === 'home')));
  try {
    if (!p[0]) return await viewHome();
    if (p[0] === 'new') return viewNew();
    if (p[0] === 'd') return await viewDevice(p[1], p[2] || 'dash');
    if (p[0] === 'notif') return await viewNotif();
    if (p[0] === 'settings') return await viewSettings();
    app.innerHTML = '<p class="empty">Halaman tidak ditemukan.</p>';
  } catch (e) {
    if (e.status === 401) { app.innerHTML = '<div class="card empty">Dashboard ini memerlukan login.</div>'; return; }
    app.innerHTML = `<div class="card"><h3>Gagal memuat</h3><p class="hint">${esc(e.message)}</p></div>`;
  }
}
window.addEventListener('hashchange', render);

// ---------------------------------------------------------------------------
// Daftar perangkat
// ---------------------------------------------------------------------------
async function viewHome() {
  const list = await api('GET', '/api/devices');
  app.innerHTML = `
    <div class="row"><div><h1>Perangkat</h1><p class="sub">Pantau perangkat IoT secara real-time.</p></div><span class="spacer"></span>
      ${ME.admin ? '<a class="btn primary" href="#/new">+ Perangkat Baru</a>' : ''}</div>
    <div class="grid cards">${list.map((d) => `
      <a class="card" href="#/d/${d.id}" style="color:inherit;text-decoration:none" data-dev="${d.id}">
        <div class="row"><span class="dot ${d.online ? 'on' : ''}"></span><h3 style="margin:0">${esc(d.name)}</h3><span class="spacer"></span>
          ${d.values.status ? `<span class="badge ${statusClass(d.values.status.v) === 'ok' ? 'ok' : statusClass(d.values.status.v)}" data-st>${esc(d.values.status.v)}</span>` : ''}</div>
        <div class="big" style="font-size:28px;font-weight:700;margin:10px 0 2px" data-level>${d.values.level ? esc(d.values.level.v) + ' <small class="hint">cm</small>' : ''}</div>
        <div class="hint">${d.online ? 'Online' : 'Offline'} · data terakhir ${ago(d.last_seen)}</div>
        <div class="hint mono">${esc(d.topic)}/#</div>
      </a>`).join('') || '<div class="card empty">Belum ada perangkat.</div>'}</div>`;
  listen((m) => { if (['v', 'online', 'config'].includes(m.t) && (m.t !== 'v' || ['status', 'level'].includes(m.k))) { clearTimeout(viewHome.t); viewHome.t = setTimeout(render, 400); } });
}

function viewNew() {
  if (!ME.admin) { app.innerHTML = '<div class="card empty">Login admin untuk menambah perangkat.</div>'; return; }
  app.innerHTML = `<h1>Perangkat Baru</h1><p class="sub">Setiap perangkat punya auth token dan topic MQTT sendiri.</p>
    <form class="card" id="f" style="max-width:560px">
      <div class="f"><label>Nama perangkat</label><input type="text" name="name" required placeholder="Sungai Bengawan Solo - Pos 2"></div>
      <div class="f"><label>Topic dasar MQTT</label><input type="text" name="topic" placeholder="awasair/pos2 (kosongkan = otomatis)"></div>
      <div class="f"><label>Template</label><select name="template"><option value="awasair">AWASAIR (datastream, widget & event siap pakai)</option><option value="blank">Kosong</option></select></div>
      <div class="row"><span class="spacer"></span><a class="btn" href="#/">Batal</a><button class="btn primary">Buat</button></div></form>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    try { const d = await api('POST', '/api/devices', Object.fromEntries(new FormData(e.target))); location.hash = `#/d/${d.id}/info`; }
    catch (err) { toast(err.message); }
  };
}

// ---------------------------------------------------------------------------
// Halaman perangkat
// ---------------------------------------------------------------------------
async function viewDevice(id, tab) {
  const d = await api('GET', `/api/devices/${id}`);
  const tabs = [['dash', 'Dashboard'], ['events', 'Event & Notifikasi']];
  if (ME.admin) tabs.push(['ds', 'Datastreams'], ['info', 'Info & Koneksi']);
  app.innerHTML = `
    <div class="row"><span class="dot ${d.online ? 'on' : ''}" id="ol"></span><h1 style="margin:0">${esc(d.name)}</h1></div>
    <div class="hint" id="olt" style="margin-top:4px">${d.online ? 'Online' : 'Offline'} · data terakhir ${ago(d.last_seen)}</div>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/d/${id}/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</nav>
    <section id="tab"></section>`;
  listen((m) => {
    if (m.d !== d.id) return;
    if (m.t === 'online') { d.online = m.online; $('#ol').className = 'dot' + (m.online ? ' on' : ''); }
    if (m.t === 'v' && m.src !== 'dashboard') d.last_seen = m.ts;
    if (m.t === 'online' || m.t === 'v') $('#olt').textContent = `${d.online ? 'Online' : 'Offline'} · data terakhir ${ago(d.last_seen)}`;
  });
  const el = $('#tab');
  if (tab === 'dash') return tabDash(el, d);
  if (tab === 'events') return tabEvents(el, d);
  if (tab === 'ds' && ME.admin) return tabDatastreams(el, d);
  if (tab === 'info' && ME.admin) return tabInfo(el, d);
}

// ---- Dashboard & widget -----------------------------------------------------
const WIDGET_TYPES = {
  status: 'Status (warna)', value: 'Nilai / Label', gauge: 'Gauge', chart: 'Grafik',
  switch: 'Switch (0/1)', slider: 'Slider', button: 'Tombol', log: 'Log notifikasi',
};

function tabDash(el, d) {
  let editing = false;
  el.innerHTML = `<div id="ban"></div>
    <div class="row" style="margin-bottom:12px">
      ${ME.admin ? '' : '<span class="hint">Mode lihat saja. Login admin untuk mengontrol perangkat.</span>'}
      <span class="spacer"></span>
      ${'Notification' in window && Notification.permission !== 'granted' ? '<button class="btn sm" id="np">🔔 Aktifkan notifikasi</button>' : ''}
      ${ME.admin ? '<button class="btn sm" id="edit">✎ Atur widget</button>' : ''}
    </div>
    <div id="addw"></div>
    <div class="widgets" id="wg"></div>`;
  $('#np')?.addEventListener('click', async () => { const r = await Notification.requestPermission(); toast(r === 'granted' ? 'Notifikasi aktif' : 'Izin notifikasi ditolak'); if (r === 'granted') $('#np').remove(); });

  const updaters = {}; // key -> [fn(value, ts)]
  const on = (key, fn) => (updaters[key] ||= []).push(fn);
  const val = (k) => d.values[k]?.v;
  const dsOf = (k) => d.config.datastreams.find((x) => x.key === k) || { key: k, name: k };
  const lineVals = (w) => String(w.lines || '').split(',').map((s) => s.trim()).filter(Boolean);

  function showBanner() {
    const s = val('status'); const c = statusClass(s);
    $('#ban').innerHTML = c === 'danger' ? `<div class="banner critical">🚨 Status ${esc(s)}: ketinggian air ${esc(val('level') ?? '-')} cm. Waspada dan ikuti arahan evakuasi.</div>`
      : c === 'warn' ? `<div class="banner warning">⚠️ Status ${esc(s)}: air mulai naik (${esc(val('level') ?? '-')} cm).</div>` : '';
  }

  function build() {
    Object.keys(updaters).forEach((k) => delete updaters[k]);
    const wg = $('#wg'); wg.innerHTML = '';
    wg.classList.toggle('editing', editing);
    d.config.widgets.forEach((w, i) => wg.appendChild(widget(w, i)));
    if (!d.config.widgets.length) wg.innerHTML = '<div class="card empty" style="grid-column:1/-1">Belum ada widget. Klik "Atur widget" untuk menambah.</div>';
    for (const [k, fns] of Object.entries(updaters)) fns.forEach((fn) => fn(val(k), d.values[k]?.ts));
    showBanner();
    $('#addw').innerHTML = editing ? addWidgetForm() : '';
    if (editing) bindAddForm();
  }

  function widget(w, i) {
    const ds = dsOf(w.key);
    const card = document.createElement('div');
    card.className = 'card widget' + (w.w === 2 ? ' w2' : '');
    card.innerHTML = `<h3>${esc(w.title || ds.name)}</h3><div class="body"></div>` +
      (editing ? `<div class="tools"><button title="Geser kiri" data-a="up">◀</button><button title="Geser kanan" data-a="down">▶</button><button title="Lebar" data-a="w">⇔</button><button title="Hapus" data-a="del">✕</button></div>` : '');
    const body = $('.body', card);
    const unit = ds.unit ? `<small>${esc(ds.unit)}</small>` : '';
    const ts = document.createElement('div'); ts.className = 'ts';

    if (w.type === 'value') {
      body.innerHTML = '<div class="big"></div>'; body.appendChild(ts);
      on(w.key, (v, t) => { $('.big', body).innerHTML = v == null ? '–' : `${esc(typeof v === 'string' && isNaN(v) ? v.charAt(0).toUpperCase() + v.slice(1) : v)}${unit}`; ts.textContent = ago(t); });
    } else if (w.type === 'status') {
      body.innerHTML = '<div class="status-pill">–</div>'; body.appendChild(ts);
      on(w.key, (v, t) => { const p = $('.status-pill', body); p.textContent = v ?? '–'; p.className = 'status-pill ' + statusClass(v, w.colors); ts.textContent = 'Diperbarui ' + ago(t); });
    } else if (w.type === 'gauge') {
      const min = Number(ds.min ?? 0), max = Number(ds.max ?? 100);
      body.classList.add('gauge');
      body.innerHTML = `<svg viewBox="0 0 200 132"><path d="M20 105 A80 80 0 0 1 180 105" fill="none" stroke="var(--border)" stroke-width="16" stroke-linecap="round"/>
        <path class="arc" d="M20 105 A80 80 0 0 1 180 105" fill="none" stroke="var(--accent)" stroke-width="16" stroke-linecap="round" pathLength="100" stroke-dasharray="0 100"/>
        <g class="marks"></g><text class="gv" x="100" y="92" text-anchor="middle">–</text><text class="gu" x="100" y="112" text-anchor="middle">${esc(ds.unit || '')}</text>
        <text class="gu" x="20" y="128" text-anchor="middle">${min}</text><text class="gu" x="180" y="128" text-anchor="middle">${max}</text></svg>`;
      body.appendChild(ts);
      const draw = () => {
        const v = Number(val(w.key)); const th = lineVals(w).map((k) => Number(val(k) ?? dsOf(k).def)).filter(Number.isFinite).sort((a, b) => a - b);
        const pct = Number.isFinite(v) ? Math.max(0, Math.min(1, (v - min) / (max - min || 1))) : 0;
        const arc = $('.arc', body);
        arc.setAttribute('stroke-dasharray', `${pct * 100} 100`);
        arc.setAttribute('stroke', th.length ? (v >= th[th.length - 1] ? 'var(--danger)' : th.length > 1 && v >= th[0] ? 'var(--warn)' : 'var(--ok)') : 'var(--accent)');
        $('.gv', body).textContent = Number.isFinite(v) ? +v.toFixed(1) : '–';
        $('.marks', body).innerHTML = th.map((t) => { const a = Math.PI * (1 - Math.max(0, Math.min(1, (t - min) / (max - min || 1)))); const x1 = 100 + 68 * Math.cos(a), y1 = 105 - 68 * Math.sin(a), x2 = 100 + 92 * Math.cos(a), y2 = 105 - 92 * Math.sin(a); return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--fg)" stroke-width="2"/>`; }).join('');
        ts.textContent = ago(d.values[w.key]?.ts);
      };
      on(w.key, draw); lineVals(w).forEach((k) => on(k, draw));
    } else if (w.type === 'chart') {
      const range = Number(ls.get('range_' + w.id, w.minutes || 60));
      body.innerHTML = `<canvas></canvas><div class="row" style="margin-top:6px"><span class="spacer"></span><select style="width:auto;padding:3px 6px;font-size:12px">${[[15, '15 menit'], [60, '1 jam'], [360, '6 jam'], [1440, '24 jam'], [10080, '7 hari']].map(([m, l]) => `<option value="${m}" ${m === range ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
      const colors = { level: '#2b5fd9', adc: '#1f9bb0' };
      const chart = new MiniChart($('canvas', body), { color: colors[w.key] || '#2b5fd9', unit: ds.unit || '' });
      const lines = () => lineVals(w).map((k, j, arr) => ({ value: Number(val(k) ?? dsOf(k).def), label: dsOf(k).name, color: j === arr.length - 1 ? '#d63b3b' : '#d99a00' })).filter((l) => Number.isFinite(l.value));
      const load = async (m) => { chart.setLines(lines()); chart.setData((await api('GET', `/api/devices/${d.id}/history?key=${encodeURIComponent(w.key)}&minutes=${m}`)).map((p) => ({ t: p.ts, v: p.v }))); };
      load(range);
      $('select', body).onchange = (e) => { ls.set('range_' + w.id, e.target.value); load(Number(e.target.value)); };
      let first = true;
      on(w.key, (v, t) => { if (first) { first = false; return; } if (v != null) chart.push({ t, v }, 2000); });
      lineVals(w).forEach((k) => on(k, () => chart.setLines(lines())));
    } else if (w.type === 'switch') {
      body.innerHTML = `<label class="switch"><input type="checkbox" ${ME.admin ? '' : 'disabled'}><span></span></label><div class="hint" style="margin-top:8px"></div>`;
      const inp = $('input', body);
      inp.onchange = () => wsWrite(d.id, w.key, inp.checked ? 1 : 0);
      on(w.key, (v) => { inp.checked = Number(v) === 1; $('.hint', body).textContent = Number(v) === 1 ? (w.onLabel || 'AKTIF') : (w.offLabel || 'NONAKTIF'); });
    } else if (w.type === 'slider') {
      const min = Number(ds.min ?? 0), max = Number(ds.max ?? 100);
      body.innerHTML = `<div class="big"><span>–</span>${unit}</div><input type="range" min="${min}" max="${max}" step="${w.step || 1}" ${ME.admin ? '' : 'disabled'}><div class="row hint"><span>${min}</span><span class="spacer"></span><span>${max}</span></div>`;
      const inp = $('input', body); const out = $('.big span', body);
      inp.oninput = () => (out.textContent = inp.value);
      inp.onchange = () => wsWrite(d.id, w.key, Number(inp.value));
      on(w.key, (v) => { const n = v ?? ds.def; if (n != null && document.activeElement !== inp) { inp.value = n; out.textContent = n; } });
    } else if (w.type === 'button') {
      body.innerHTML = `<button class="btn primary push" ${ME.admin ? '' : 'disabled'}>${esc(w.label || 'Kirim')}</button>`;
      $('button', body).onclick = () => { wsWrite(d.id, w.key, w.value ?? 1); toast('Perintah dikirim'); };
    } else if (w.type === 'log') {
      body.innerHTML = '<ul class="evlist"></ul>'; body.style.justifyContent = 'flex-start';
      const ul = $('ul', body);
      const item = (e) => `<li><span class="lv ${e.level}"></span><div><div>${esc(e.message)}</div><div class="when">${fmt(e.ts)}</div></div></li>`;
      api('GET', `/api/devices/${d.id}/events?limit=6`).then((evs) => { ul.innerHTML = evs.map(item).join('') || '<li class="hint">Belum ada notifikasi</li>'; });
      listen((m) => { if (m.t === 'event' && m.d === d.id) { if (!ul.querySelector('.lv')) ul.innerHTML = ''; ul.insertAdjacentHTML('afterbegin', item(m.ev)); while (ul.children.length > 6) ul.lastChild.remove(); } });
    }

    card.querySelectorAll('.tools button').forEach((b) => (b.onclick = () => {
      const ws_ = d.config.widgets;
      if (b.dataset.a === 'del') ws_.splice(i, 1);
      if (b.dataset.a === 'up' && i > 0) [ws_[i - 1], ws_[i]] = [ws_[i], ws_[i - 1]];
      if (b.dataset.a === 'down' && i < ws_.length - 1) [ws_[i + 1], ws_[i]] = [ws_[i], ws_[i + 1]];
      if (b.dataset.a === 'w') w.w = w.w === 2 ? 1 : 2;
      saveConfig();
    }));
    return card;
  }

  function addWidgetForm() {
    return `<form class="card" id="wf" style="margin-bottom:14px"><h3>Tambah widget</h3>
      <div class="form-grid">
        <div class="f"><label>Jenis</label><select name="type">${Object.entries(WIDGET_TYPES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
        <div class="f"><label>Datastream</label><select name="key">${d.config.datastreams.map((x) => `<option value="${esc(x.key)}">${esc(x.name)} (${esc(x.key)}, ${x.dir})</option>`).join('')}</select></div>
        <div class="f"><label>Judul</label><input type="text" name="title" placeholder="(nama datastream)"></div>
        <div class="f"><label>Lebar</label><select name="w"><option value="1">1 kolom</option><option value="2">2 kolom</option></select></div>
        <div class="f"><label>Garis ambang (untuk gauge/grafik)</label><input type="text" name="lines" placeholder="siaga,bahaya"></div>
        <div class="f"><label>Rentang grafik (menit)</label><input type="number" name="minutes" value="60"></div>
      </div>
      <p class="hint">Switch, slider, dan tombol hanya untuk datastream arah <b>out</b> (dashboard → perangkat).</p>
      <div class="row"><span class="spacer"></span><button class="btn primary">Tambah</button></div></form>`;
  }
  function bindAddForm() {
    $('#wf').onsubmit = (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const ds = dsOf(f.key);
      if (['switch', 'slider', 'button'].includes(f.type) && ds.dir !== 'out') return toast('Widget kontrol butuh datastream arah "out"');
      d.config.widgets.push({ id: uid(), type: f.type, key: f.type === 'log' ? undefined : f.key, title: f.title, w: Number(f.w), lines: f.lines || undefined, minutes: Number(f.minutes) || 60 });
      saveConfig();
    };
  }
  async function saveConfig() {
    try { await api('PUT', `/api/devices/${d.id}`, { config: d.config }); build(); } catch (e) { toast(e.message); }
  }

  $('#edit')?.addEventListener('click', () => { editing = !editing; $('#edit').textContent = editing ? '✓ Selesai' : '✎ Atur widget'; build(); });
  listen((m) => {
    if (m.d !== d.id) return;
    if (m.t === 'v') { d.values[m.k] = { v: m.v, ts: m.ts }; (updaters[m.k] || []).forEach((fn) => fn(m.v, m.ts)); if (m.k === 'status' || m.k === 'level') showBanner(); }
  });
  build();
}

// ---- Event & notifikasi -------------------------------------------------------
async function tabEvents(el, d) {
  const evs = await api('GET', `/api/devices/${d.id}/events?limit=100`);
  const lvl = { info: 'Info', warning: 'Peringatan', critical: 'Kritis' };
  el.innerHTML = `
    ${ME.admin ? `<h2 style="margin-top:0">Aturan event</h2><p class="sub">Event dicatat (dan dikirim ke Telegram bila dicentang) saat kondisi <b>baru</b> terpenuhi. Pesan bisa memakai {{key}} datastream, misal {{level}}.</p>
    <div class="card table-wrap"><table class="edit-table"><thead><tr><th>Datastream</th><th>Kondisi</th><th>Nilai</th><th>Level</th><th>Pesan</th><th>Telegram</th><th></th></tr></thead><tbody id="rules"></tbody></table>
      <div class="row" style="margin-top:10px"><label style="margin:0;font-weight:400"><input type="checkbox" id="nof" ${d.config.notifyOffline ? 'checked' : ''}> Catat event saat perangkat offline</label><span class="spacer"></span><button class="btn" id="addr">+ Aturan</button><button class="btn primary" id="saver">Simpan aturan</button></div></div>` : ''}
    <div class="row"><h2>Riwayat event</h2><span class="spacer"></span>
      <label style="margin:0;font-weight:400"><input type="checkbox" id="snd" ${ls.get('sound', '1') === '1' ? 'checked' : ''}> Bunyi untuk event kritis</label>
      ${ME.admin ? '<button class="btn sm danger" id="clr">Hapus riwayat</button>' : ''}</div>
    <div class="card"><ul class="evlist" id="evl">${evs.map((e) => `<li><span class="lv ${e.level}"></span><div><div><b>${lvl[e.level] || e.level}</b> · ${esc(e.message)}</div><div class="when">${fmt(e.ts)}</div></div></li>`).join('') || '<li class="hint">Belum ada event</li>'}</ul></div>`;
  $('#snd').onchange = (e) => ls.set('sound', e.target.checked ? '1' : '0');
  listen((m) => { if (m.t === 'event' && m.d === d.id) $('#evl').insertAdjacentHTML('afterbegin', `<li><span class="lv ${m.ev.level}"></span><div><div><b>${lvl[m.ev.level]}</b> · ${esc(m.ev.message)}</div><div class="when">${fmt(m.ev.ts)}</div></div></li>`); });
  if (!ME.admin) return;
  $('#clr').onclick = async () => { if (confirm('Hapus semua riwayat event perangkat ini?')) { await api('DELETE', `/api/devices/${d.id}/events`); render(); } };
  const rules = structuredClone(d.config.events);
  const draw = () => {
    $('#rules').innerHTML = rules.map((r, i) => `<tr data-i="${i}">
      <td><select data-f="key">${d.config.datastreams.map((x) => `<option ${x.key === r.key ? 'selected' : ''}>${esc(x.key)}</option>`).join('')}</select></td>
      <td><select data-f="op">${['==', '!=', '>', '>=', '<', '<=', 'change'].map((o) => `<option ${o === r.op ? 'selected' : ''}>${o}</option>`).join('')}</select></td>
      <td><input type="text" data-f="value" value="${esc(r.value)}" style="width:90px"></td>
      <td><select data-f="level">${Object.entries(lvl).map(([k, l]) => `<option value="${k}" ${k === r.level ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><input type="text" data-f="message" value="${esc(r.message)}" style="min-width:240px"></td>
      <td><input type="checkbox" data-f="telegram" ${r.telegram ? 'checked' : ''}></td>
      <td><button class="btn sm danger" data-del>✕</button></td></tr>`).join('') || '<tr><td colspan="7" class="hint">Belum ada aturan</td></tr>';
    $('#rules').querySelectorAll('[data-f]').forEach((inp) => (inp.onchange = () => { const r = rules[inp.closest('tr').dataset.i]; r[inp.dataset.f] = inp.type === 'checkbox' ? inp.checked : inp.value; }));
    $('#rules').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { rules.splice(b.closest('tr').dataset.i, 1); draw(); }));
  };
  draw();
  $('#addr').onclick = () => { rules.push({ id: uid(), key: d.config.datastreams[0]?.key || '', op: '==', value: '', level: 'warning', message: '', telegram: false }); draw(); };
  $('#saver').onclick = async () => {
    try { await api('PUT', `/api/devices/${d.id}`, { config: { ...d.config, events: rules, notifyOffline: $('#nof').checked } }); toast('Aturan disimpan'); d.config.events = rules; }
    catch (e) { toast(e.message); }
  };
}

// ---- Datastreams ----------------------------------------------------------------
function tabDatastreams(el, d) {
  const list = structuredClone(d.config.datastreams);
  el.innerHTML = `<p class="sub">Datastream = saluran data (mirip "virtual pin" di Blynk). Arah <b>in</b>: perangkat → server (publish ke <code>${esc(d.topic)}/&lt;key&gt;</code>). Arah <b>out</b>: dashboard → perangkat (dikirim ke <code>${esc(d.topic)}/cmd</code> sebagai <code>{"&lt;key&gt;":nilai}</code>, mis. <code>{"mute":true}</code>)${d.config.useAck ? '. Nilai out yang tampil diambil dari <code>' + esc(d.topic) + '/ack</code> (konfigurasi yang berlaku di alat)' : ''}.</p>
    <div class="card table-wrap"><table class="edit-table"><thead><tr><th>Key</th><th>Nama</th><th>Tipe</th><th>Arah</th><th>Satuan</th><th>Min</th><th>Max</th><th>Default</th><th>Nilai terakhir</th><th></th></tr></thead><tbody id="dsb"></tbody></table>
    <div class="row" style="margin-top:10px"><span class="spacer"></span><button class="btn" id="add">+ Datastream</button><button class="btn primary" id="save">Simpan</button></div></div>
    <h2>Ekspor riwayat</h2><div class="card"><a class="btn" href="/api/devices/${d.id}/history.csv?minutes=1440">CSV 24 jam</a> <a class="btn" href="/api/devices/${d.id}/history.csv?minutes=10080">CSV 7 hari</a></div>`;
  const draw = () => {
    $('#dsb').innerHTML = list.map((x, i) => `<tr data-i="${i}">
      <td><input type="text" data-f="key" value="${esc(x.key)}" style="width:110px" class="mono"></td>
      <td><input type="text" data-f="name" value="${esc(x.name)}" style="min-width:140px"></td>
      <td><select data-f="type"><option value="number" ${x.type === 'number' ? 'selected' : ''}>angka</option><option value="string" ${x.type === 'string' ? 'selected' : ''}>teks</option><option value="bool" ${x.type === 'bool' ? 'selected' : ''}>boolean</option></select></td>
      <td><select data-f="dir"><option ${x.dir === 'in' ? 'selected' : ''}>in</option><option ${x.dir === 'out' ? 'selected' : ''}>out</option></select></td>
      <td><input type="text" data-f="unit" value="${esc(x.unit)}" style="width:60px"></td>
      <td><input type="number" data-f="min" value="${esc(x.min)}" style="width:70px"></td>
      <td><input type="number" data-f="max" value="${esc(x.max)}" style="width:70px"></td>
      <td><input type="text" data-f="def" value="${esc(x.def)}" style="width:60px"></td>
      <td class="hint">${esc(d.values[x.key]?.v ?? '-')}</td>
      <td><button class="btn sm danger" data-del>✕</button></td></tr>`).join('');
    $('#dsb').querySelectorAll('[data-f]').forEach((inp) => (inp.onchange = () => {
      const x = list[inp.closest('tr').dataset.i]; const f = inp.dataset.f;
      x[f] = ['min', 'max'].includes(f) ? (inp.value === '' ? undefined : Number(inp.value)) : f === 'def' ? (inp.value === '' ? undefined : isNaN(inp.value) ? inp.value : Number(inp.value)) : inp.value;
    }));
    $('#dsb').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { list.splice(b.closest('tr').dataset.i, 1); draw(); }));
  };
  draw();
  $('#add').onclick = () => { list.push({ key: 'data' + (list.length + 1), name: 'Data baru', type: 'number', dir: 'in' }); draw(); };
  $('#save').onclick = async () => {
    try { const r = await api('PUT', `/api/devices/${d.id}`, { config: { ...d.config, datastreams: list } }); d.config = r.config; toast('Datastream disimpan'); }
    catch (e) { toast(e.message); }
  };
}

// ---- Info & koneksi -------------------------------------------------------------
function tabInfo(el, d) {
  const host = location.hostname;
  el.innerHTML = `<div class="grid cards">
    <div class="card"><h3>Auth token</h3><p class="hint">Dipakai sebagai <b>password MQTT</b> perangkat. Rahasiakan.</p>
      <div class="keybox"><input type="text" readonly value="${d.token}"><button class="btn sm" id="cp">Salin</button></div>
      <div class="row" style="margin-top:10px"><button class="btn sm danger" id="regen">Buat token baru</button></div></div>
    <div class="card"><h3>Koneksi MQTT</h3>
      <table><tr><td class="hint">Broker</td><td class="mono">${esc(host)}</td></tr><tr><td class="hint">Port</td><td class="mono">${ME.mqttPort} (TCP), ${ME.httpPort} path /mqtt (WebSocket)</td></tr>
      <tr><td class="hint">Username</td><td class="mono">bebas (mis. ${esc(d.id)})</td></tr><tr><td class="hint">Password</td><td class="mono">auth token</td></tr>
      <tr><td class="hint">Publish</td><td class="mono">${esc(d.topic)}/data (JSON), /status, /online, /ack</td></tr>
      <tr><td class="hint">Subscribe</td><td class="mono">${esc(d.topic)}/cmd</td></tr></table>
      <p class="hint">Gunakan IP laptop server (bukan "localhost") di firmware ESP32, mis. 192.168.1.10.</p></div>
    <div class="card"><h3>Pengaturan perangkat</h3><form id="pf">
      <div class="f"><label>Nama</label><input type="text" name="name" value="${esc(d.name)}"></div>
      <div class="f"><label>Topic dasar</label><input type="text" name="topic" value="${esc(d.topic)}" class="mono"></div>
      <div class="row"><button type="button" class="btn danger" id="del">Hapus perangkat</button><span class="spacer"></span><button class="btn primary">Simpan</button></div></form></div>
  </div>
  <h2>HTTP API (alternatif tanpa MQTT)</h2>
  <div class="card"><pre>Kirim data   : http://${esc(location.host)}/external/api/update?token=${d.token}&amp;level=150&amp;status=NORMAL
Baca nilai   : http://${esc(location.host)}/external/api/get?token=${d.token}&amp;key=level
Semua nilai  : http://${esc(location.host)}/external/api/get?token=${d.token}
Kontrol      : http://${esc(location.host)}/external/api/write?token=${d.token}&amp;key=mute&amp;value=1
Status online: http://${esc(location.host)}/external/api/isHardwareConnected?token=${d.token}</pre></div>
  <h2>Contoh firmware (PubSubClient)</h2>
  <div class="card"><pre>const char* MQTT_HOST  = "${esc(host)}";
const int   MQTT_PORT  = ${ME.mqttPort};
const char* AUTH_TOKEN = "${d.token}";
const char* TOPIC_BASE = "${esc(d.topic)}";

mqtt.setServer(MQTT_HOST, MQTT_PORT);
mqtt.connect("esp32-${esc(d.id)}", "device", AUTH_TOKEN, "${esc(d.topic)}/online", 1, true, "offline");
mqtt.subscribe("${esc(d.topic)}/cmd", 1);
mqtt.publish("${esc(d.topic)}/data", "{\"level\":245.3,\"jarak\":54.7,\"adc\":1800,\"hujan\":\"sedang\",\"status\":\"BAHAYA\"}");</pre>
  <p class="hint">Format lengkap: <code>docs/mqtt-contract.md</code>. Firmware siap pakai: <code>firmware/awasair_esp32/</code>.</p></div>
  <h2>Simulator (tanpa hardware)</h2>
  <div class="card"><pre>npm run simulator -- --token ${d.token} --topic ${esc(d.topic)}</pre></div>`;
  $('#cp').onclick = () => { navigator.clipboard?.writeText(d.token); toast('Token disalin'); };
  $('#regen').onclick = async () => { if (confirm('Token lama langsung tidak berlaku dan perangkat akan terputus. Lanjut?')) { await api('POST', `/api/devices/${d.id}/token`); render(); } };
  $('#pf').onsubmit = async (e) => { e.preventDefault(); try { await api('PUT', `/api/devices/${d.id}`, Object.fromEntries(new FormData(e.target))); toast('Tersimpan'); render(); } catch (err) { toast(err.message); } };
  $('#del').onclick = async () => { if (prompt(`Ketik "${d.name}" untuk menghapus perangkat beserta datanya:`) === d.name) { await api('DELETE', `/api/devices/${d.id}`); location.hash = '#/'; } };
}

// ---------------------------------------------------------------------------
// Semua notifikasi
// ---------------------------------------------------------------------------
async function viewNotif() {
  const [evs, devs] = await Promise.all([api('GET', '/api/events?limit=200'), api('GET', '/api/devices')]);
  const name = Object.fromEntries(devs.map((d) => [d.id, d.name]));
  const item = (e) => `<li><span class="lv ${e.level}"></span><div><div><b>${esc(name[e.device_id] || e.device_id)}</b> · ${esc(e.message)}</div><div class="when">${fmt(e.ts)}</div></div></li>`;
  app.innerHTML = `<div class="row"><div><h1>Notifikasi</h1><p class="sub">Semua peringatan dan perubahan status dari seluruh perangkat.</p></div><span class="spacer"></span>
    ${'Notification' in window && Notification.permission !== 'granted' ? '<button class="btn sm" id="np">🔔 Aktifkan notifikasi browser</button>' : ''}</div>
    <div class="card"><ul class="evlist" id="evl">${evs.map(item).join('') || '<li class="hint">Belum ada notifikasi</li>'}</ul></div>`;
  $('#np')?.addEventListener('click', async () => { if ((await Notification.requestPermission()) === 'granted') { toast('Notifikasi aktif'); $('#np').remove(); } });
  listen((m) => { if (m.t === 'event') $('#evl').insertAdjacentHTML('afterbegin', item(m.ev)); });
}

// ---------------------------------------------------------------------------
// Pengaturan
// ---------------------------------------------------------------------------
async function viewSettings() {
  if (!ME.admin) { app.innerHTML = '<div class="card empty">Login admin untuk membuka pengaturan.</div>'; return; }
  const s = await api('GET', '/api/settings');
  app.innerHTML = `<h1>Pengaturan</h1><p class="sub">Notifikasi Telegram dikirim untuk event yang dicentang "Telegram", sehingga tetap masuk walau HP terkunci.</p>
    <form class="card" id="f" style="max-width:640px"><h3>Bot Telegram</h3>
      <ol class="hint"><li>Chat <b>@BotFather</b> → <code>/newbot</code> → salin token.</li><li>Kirim pesan apa saja ke bot kalian (atau tambahkan bot ke grup warga).</li>
      <li>Buka <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> dan salin nilai <code>chat.id</code>.</li></ol>
      <div class="f"><label>Token bot</label><input type="password" name="telegram_token" value="${esc(s.telegram_token)}" placeholder="123456:ABC-DEF..."></div>
      <div class="f"><label>Chat ID penerima (pisahkan dengan koma)</label><input type="text" name="telegram_chats" value="${esc(s.telegram_chats)}" placeholder="123456789, -1001234567890"></div>
      <div class="row"><button type="button" class="btn" id="test">Kirim pesan tes</button><span class="spacer"></span><button class="btn primary">Simpan</button></div></form>
    <div class="card" style="max-width:640px;margin-top:14px"><h3>Akses publik</h3><p class="hint">Mode lihat-tanpa-login: <b>${ME.publicView ? 'aktif' : 'nonaktif'}</b>. Ubah lewat env <code>PUBLIC_VIEW=false</code> atau <code>config.json</code>. Kontrol perangkat selalu butuh login admin.</p></div>`;
  $('#f').onsubmit = async (e) => { e.preventDefault(); await api('PUT', '/api/settings', Object.fromEntries(new FormData(e.target))); toast('Tersimpan'); };
  $('#test').onclick = async () => { try { await api('PUT', '/api/settings', Object.fromEntries(new FormData($('#f')))); await api('POST', '/api/settings/telegram-test'); toast('Pesan tes dikirim'); } catch (e) { toast(e.message); } };
}

loadMe().then(() => { connectWs(); render(); });
