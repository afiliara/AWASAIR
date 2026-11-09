// AwasLink Data Logger (fitur ala ThingSpeak) - frontend (SPA, hash routing, tanpa framework)
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const FIELDS = [1, 2, 3, 4, 5, 6, 7, 8];
const COLORS = ['#2a7de1', '#1e9e5a', '#d63b3b', '#8a5cd6', '#d99a00', '#1f9bb0', '#c2448f', '#6b7686'];
let ME = { admin: false };
let cleanup = []; // fungsi pembersih (EventSource, interval) saat pindah halaman

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (s) => (s ? new Date(s).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'medium' }) : '-');
const ago = (s) => {
  if (!s) return '-';
  const d = (Date.now() - new Date(s)) / 1000;
  if (d < 60) return Math.max(0, Math.round(d)) + ' detik lalu';
  if (d < 3600) return Math.round(d / 60) + ' menit lalu';
  if (d < 86400) return Math.round(d / 3600) + ' jam lalu';
  return Math.round(d / 86400) + ' hari lalu';
};
const readKey = (id) => { try { return localStorage.getItem('rk_' + id) || ''; } catch { return ''; } };
const saveReadKey = (id, k) => { try { localStorage.setItem('rk_' + id, k); } catch {} };
const withKey = (url, id) => { const k = readKey(id); return k ? url + (url.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(k) : url; };

function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
}

async function api(method, url, body) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    if (typeof body === 'string') { opt.headers['Content-Type'] = 'text/csv'; opt.body = body; }
    else { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  }
  const r = await fetch(url, opt);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) { const e = new Error((data && data.error) || 'HTTP ' + r.status); e.status = r.status; throw e; }
  return data;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function loadMe() {
  ME = await api('GET', '/api/me');
  if (!ME.admin) { location.replace('/'); return; } // halaman ini khusus admin
  document.querySelectorAll('.admin-only').forEach((el) => (el.hidden = !ME.admin));
}

function showLogin() {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<form class="card modal">
    <h3>Login admin AwasLink</h3>
    <div class="f"><label>Username</label><input type="text" name="username" autocomplete="username" required></div>
    <div class="f"><label>Password</label><input type="password" name="password" autocomplete="current-password" required></div>
    <p class="hint" id="err"></p>
    <div class="row"><span class="spacer"></span><button type="button" class="btn" id="cancel">Batal</button><button class="btn primary">Masuk</button></div>
  </form>`;
  document.body.appendChild(bg);
  bg.querySelector('input').focus();
  $('#cancel', bg).onclick = () => bg.remove();
  bg.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try { await api('POST', '/api/login', fd); bg.remove(); await loadMe(); render(); toast('Berhasil login'); }
    catch (err) { $('#err', bg).textContent = err.message; }
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function render() {
  cleanup.forEach((f) => f()); cleanup = [];
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.r === (parts[0] || 'home')));
  try {
    if (!parts[0]) return await viewHome();
    if (parts[0] === 'new') return viewChannelForm();
    if (parts[0] === 'channel') return await viewChannel(Number(parts[1]), parts[2] || 'view');
    if (parts[0] === 'settings') return await viewSettings();
    if (parts[0] === 'docs') return viewDocs();
    app.innerHTML = '<p class="empty">Halaman tidak ditemukan.</p>';
  } catch (e) {
    app.innerHTML = `<div class="card"><h3>Gagal memuat</h3><p class="hint">${esc(e.message)}</p></div>`;
  }
}
window.addEventListener('hashchange', render);

// ---------------------------------------------------------------------------
// Daftar channel
// ---------------------------------------------------------------------------
async function viewHome() {
  const list = await api('GET', '/api/channels');
  app.innerHTML = `
    <div class="row"><div><h1>Channels</h1><p class="sub">Setiap channel menampung hingga 8 field data dari perangkat IoT.</p></div>
      <span class="spacer"></span>${ME.admin ? '<a class="btn primary" href="#/new">+ Channel Baru</a>' : ''}</div>
    ${list.length ? '' : `<div class="card empty">${ME.admin ? 'Belum ada channel. Buat channel baru untuk mulai.' : 'Belum ada channel publik. Login admin untuk melihat channel privat.'}</div>`}
    <div class="grid cards">${list.map((c) => `
      <a class="card" href="#/channel/${c.id}" style="color:inherit;text-decoration:none">
        <div class="row"><h3 style="margin:0">${esc(c.name)}</h3><span class="spacer"></span>
          <span class="badge ${c.public ? 'pub' : ''}">${c.public ? 'Publik' : 'Privat'}</span></div>
        <p class="hint" style="margin:6px 0 10px">${esc(c.description || 'Tanpa deskripsi')}</p>
        <div class="hint">ID ${c.id} · ${c.last_entry_id} entri · update ${ago(c.updated_at)}</div>
        <div class="hint">${FIELDS.filter((n) => c['field' + n]).map((n) => esc(c['field' + n])).join(' · ')}</div>
      </a>`).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Form channel (baru / edit)
// ---------------------------------------------------------------------------
function channelFormHtml(c = {}) {
  return `
    <div class="form-grid">
      <div class="f"><label>Nama channel</label><input type="text" name="name" required value="${esc(c.name)}"></div>
      <div class="f"><label>Visibilitas</label><select name="public"><option value="0">Privat (butuh Read API key)</option><option value="1" ${c.public ? 'selected' : ''}>Publik (bisa dilihat siapa saja)</option></select></div>
    </div>
    <div class="f"><label>Deskripsi</label><input type="text" name="description" value="${esc(c.description)}"></div>
    <div class="form-grid">
      ${FIELDS.map((n) => `<div class="f"><label>Field ${n}</label><input type="text" name="field${n}" placeholder="(tidak dipakai)" value="${esc(c['field' + n])}"></div>`).join('')}
      <div class="f"><label>Latitude</label><input type="text" name="latitude" value="${esc(c.latitude)}"></div>
      <div class="f"><label>Longitude</label><input type="text" name="longitude" value="${esc(c.longitude)}"></div>
    </div>`;
}

function viewChannelForm() {
  if (!ME.admin) { app.innerHTML = '<div class="card empty">Login admin untuk membuat channel.</div>'; return; }
  app.innerHTML = `<h1>Channel Baru</h1><p class="sub">Isi nama field yang akan dikirim perangkat (field1 sampai field8).</p>
    <form class="card" id="f">${channelFormHtml({ field1: 'Field 1' })}
      <div class="row"><span class="spacer"></span><a class="btn" href="#/">Batal</a><button class="btn primary">Simpan Channel</button></div></form>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const c = await api('POST', '/api/channels', Object.fromEntries(new FormData(e.target)));
    toast('Channel dibuat'); location.hash = `#/channel/${c.id}/keys`;
  };
}

// ---------------------------------------------------------------------------
// Halaman channel
// ---------------------------------------------------------------------------
async function viewChannel(id, tab) {
  let ch;
  try { ch = await api('GET', withKey(`/api/channels/${id}`, id)); }
  catch (e) {
    if (e.status !== 401) throw e;
    app.innerHTML = `<form class="card" id="rk" style="max-width:460px">
      <h3>Channel ${id} bersifat privat</h3><p class="hint">Masukkan Read API key, atau login sebagai admin.</p>
      <div class="f"><input type="text" name="k" placeholder="Read API key" required class="mono"></div>
      <button class="btn primary">Buka</button></form>`;
    $('#rk').onsubmit = (ev) => { ev.preventDefault(); saveReadKey(id, ev.target.k.value.trim().toUpperCase()); render(); };
    return;
  }
  const tabs = [['view', 'Tampilan'], ['data', 'Data & Ekspor']];
  if (ch.admin) tabs.push(['keys', 'API Keys'], ['react', 'React'], ['edit', 'Pengaturan Channel']);
  app.innerHTML = `
    <div class="row"><div><h1>${esc(ch.name)}</h1><p class="sub" style="margin:0">${esc(ch.description || '')}</p></div></div>
    <div class="hint" style="margin-top:6px">Channel ID <b>${ch.id}</b> · <span class="badge ${ch.public ? 'pub' : ''}">${ch.public ? 'Publik' : 'Privat'}</span> · ${ch.entries} entri · dibuat ${fmtDate(ch.created_at)}</div>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/channel/${id}/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</nav>
    <section id="tab"></section>`;
  const el = $('#tab');
  if (tab === 'view') return tabView(el, ch);
  if (tab === 'data') return tabData(el, ch);
  if (tab === 'keys' && ch.admin) return tabKeys(el, ch);
  if (tab === 'react' && ch.admin) return tabReact(el, ch);
  if (tab === 'edit' && ch.admin) return tabEdit(el, ch);
  el.innerHTML = '<p class="empty">Tab tidak tersedia.</p>';
}

// ---- Tab: Tampilan (grafik) -----------------------------------------------
const RANGES = { last100: ['100 data terakhir', 'results=100'], h1: ['1 jam', 'minutes=60'], h6: ['6 jam', 'minutes=360'], d1: ['24 jam', 'days=1'], d7: ['7 hari', 'days=7'], d30: ['30 hari', 'days=30'] };

async function tabView(el, ch) {
  let range; try { range = localStorage.getItem('range') || 'last100'; } catch { range = 'last100'; }
  const used = FIELDS.filter((n) => ch['field' + n]);
  el.innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <label style="margin:0">Rentang:</label>
      <select id="range" style="width:auto">${Object.entries(RANGES).map(([k, [l]]) => `<option value="${k}" ${k === range ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="spacer"></span><span class="live" id="live">menghubungkan…</span>
    </div>
    <div class="grid stats" id="stats">
      ${used.map((n) => `<div class="card stat"><div class="k">${esc(ch['field' + n])}</div><div class="v" id="sv${n}">–</div><div class="t" id="st${n}"></div></div>`).join('')}
      <div class="card stat"><div class="k">Status terakhir</div><div class="v" id="svs" style="font-size:20px">–</div><div class="t" id="sts"></div></div>
    </div>
    <h2>Grafik</h2>
    <div class="grid charts">${used.map((n) => `<div class="card chart-card"><h3>Field ${n}: ${esc(ch['field' + n])}</h3><canvas id="c${n}"></canvas></div>`).join('') || '<p class="empty">Channel ini belum punya field.</p>'}</div>`;

  const charts = {};
  used.forEach((n) => (charts[n] = new MiniChart($('#c' + n), { color: COLORS[n - 1] })));
  const setStat = (n, v, t) => { const a = $('#sv' + n); if (a) { a.textContent = v ?? '–'; $('#st' + n).textContent = t ? ago(t) : ''; } };
  const setStatus = (s, t) => {
    const cls = /bahaya/i.test(s) ? 'danger' : /siaga/i.test(s) ? 'warn' : /normal/i.test(s) ? 'ok' : '';
    $('#svs').innerHTML = s ? `<span class="badge ${cls}" style="font-size:15px;padding:3px 12px">${esc(s)}</span>` : '–';
    $('#sts').textContent = t ? ago(t) : '';
  };

  async function load() {
    const q = RANGES[range][1];
    const data = await api('GET', withKey(`/channels/${ch.id}/feeds.json?${q}`, ch.id));
    used.forEach((n) => {
      charts[n].setData(data.feeds.map((f) => ({ t: f.created_at, v: f['field' + n] })));
      const last = [...data.feeds].reverse().find((f) => f['field' + n] != null);
      setStat(n, last?.['field' + n], last?.created_at);
    });
    const lastS = [...data.feeds].reverse().find((f) => f.status);
    setStatus(lastS?.status, lastS?.created_at);
  }
  await load();
  $('#range').onchange = (e) => { range = e.target.value; try { localStorage.setItem('range', range); } catch {} load(); };

  const es = new EventSource(withKey(`/channels/${ch.id}/stream`, ch.id));
  es.onopen = () => { $('#live').className = 'live on'; $('#live').textContent = 'live'; };
  es.onerror = () => { const l = $('#live'); if (l) { l.className = 'live'; l.textContent = 'terputus, mencoba lagi…'; } };
  es.addEventListener('feed', (e) => {
    const f = JSON.parse(e.data);
    used.forEach((n) => { if (f['field' + n] != null) { charts[n].push({ t: f.created_at, v: f['field' + n] }, 8000); setStat(n, f['field' + n], f.created_at); } });
    if (f.status) setStatus(f.status, f.created_at);
  });
  cleanup.push(() => es.close());
}

// ---- Tab: Data & Ekspor ----------------------------------------------------
async function tabData(el, ch) {
  const data = await api('GET', withKey(`/channels/${ch.id}/feeds.json?results=25`, ch.id));
  const used = FIELDS.filter((n) => ch['field' + n]);
  el.innerHTML = `
    <div class="grid cards">
      <div class="card"><h3>Ekspor</h3><p class="hint">Unduh semua data (maks. 8000 baris terakhir) dalam format CSV.</p>
        <a class="btn" href="${withKey(`/channels/${ch.id}/feeds.csv?results=8000`, ch.id)}">Unduh CSV</a>
        <a class="btn" target="_blank" href="${withKey(`/channels/${ch.id}/feeds.json?results=8000`, ch.id)}">Lihat JSON</a></div>
      ${ch.admin ? `<div class="card"><h3>Impor CSV</h3><p class="hint">Header wajib, contoh: <code>created_at,field1,field2,status</code></p>
        <input type="file" id="file" accept=".csv,text/csv"><div class="row" style="margin-top:10px"><button class="btn" id="imp">Impor</button></div></div>
      <div class="card"><h3>Hapus data</h3><p class="hint">Menghapus seluruh entri pada channel ini. Tidak bisa dibatalkan.</p>
        <button class="btn danger" id="clear">Hapus semua data</button></div>` : ''}
    </div>
    <h2>25 entri terakhir</h2>
    <div class="card table-wrap"><table><thead><tr><th>#</th><th>Waktu</th>${used.map((n) => `<th>${esc(ch['field' + n])}</th>`).join('')}<th>Status</th></tr></thead>
      <tbody>${[...data.feeds].reverse().map((f) => `<tr><td>${f.entry_id}</td><td>${fmtDate(f.created_at)}</td>${used.map((n) => `<td>${esc(f['field' + n] ?? '')}</td>`).join('')}<td>${esc(f.status ?? '')}</td></tr>`).join('') || `<tr><td colspan="9" class="empty">Belum ada data</td></tr>`}</tbody></table></div>`;
  $('#imp')?.addEventListener('click', async () => {
    const f = $('#file').files[0]; if (!f) return toast('Pilih file CSV dulu');
    const r = await api('POST', `/api/channels/${ch.id}/import`, await f.text());
    toast(`${r.imported} baris diimpor`); render();
  });
  $('#clear')?.addEventListener('click', async () => {
    if (!confirm(`Hapus SEMUA data di channel "${ch.name}"?`)) return;
    await api('DELETE', `/api/channels/${ch.id}/feeds`); toast('Data dihapus'); render();
  });
}

// ---- Tab: API Keys ---------------------------------------------------------
function tabKeys(el, ch) {
  const host = location.origin;
  el.innerHTML = `
    <div class="grid cards">
      <div class="card"><h3>Write API Key</h3><p class="hint">Dipakai perangkat (ESP32) untuk mengirim data.</p>
        <div class="keybox"><input type="text" readonly value="${ch.write_key}"><button class="btn sm" data-copy="${ch.write_key}">Salin</button></div>
        <div class="row" style="margin-top:10px"><button class="btn sm danger" data-regen="write">Buat key baru</button></div></div>
      <div class="card"><h3>Read API Key</h3><p class="hint">Dipakai aplikasi lain untuk membaca data channel privat.</p>
        <div class="keybox"><input type="text" readonly value="${ch.read_key}"><button class="btn sm" data-copy="${ch.read_key}">Salin</button></div>
        <div class="row" style="margin-top:10px"><button class="btn sm danger" data-regen="read">Buat key baru</button></div></div>
    </div>
    <h2>Contoh request</h2>
    <div class="card">
      <h3>Kirim data (GET)</h3><pre>${host}/update?api_key=${ch.write_key}&amp;field1=150&amp;field2=3800&amp;status=NORMAL</pre>
      <h3>Kirim data (POST)</h3><pre>POST ${host}/update
Content-Type: application/x-www-form-urlencoded

api_key=${ch.write_key}&amp;field1=150&amp;field2=3800</pre>
      <h3>Baca feed</h3><pre>${host}/channels/${ch.id}/feeds.json?api_key=${ch.read_key}&amp;results=10</pre>
      <h3>Baca satu field</h3><pre>${host}/channels/${ch.id}/fields/1.json?api_key=${ch.read_key}&amp;results=10</pre>
      <h3>Nilai terakhir</h3><pre>${host}/channels/${ch.id}/feeds/last.json?api_key=${ch.read_key}</pre>
    </div>`;
  el.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copy); toast('Disalin'); }));
  el.querySelectorAll('[data-regen]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Key lama langsung tidak berlaku. Perangkat harus diperbarui. Lanjut?')) return;
    await api('POST', `/api/channels/${ch.id}/keys`, { type: b.dataset.regen }); toast('Key diperbarui'); render();
  }));
}

// ---- Tab: React -------------------------------------------------------------
async function tabReact(el, ch) {
  const { reacts, log } = await api('GET', `/api/channels/${ch.id}/reacts`);
  const used = FIELDS.filter((n) => ch['field' + n]);
  const actLabel = { log: 'Catat log saja', webhook: 'Webhook (HTTP POST)', telegram: 'Pesan Telegram' };
  el.innerHTML = `
    <p class="sub">React menjalankan aksi otomatis saat data baru memenuhi kondisi, misalnya kirim Telegram saat status BAHAYA.</p>
    <div class="card table-wrap"><table><thead><tr><th>Nama</th><th>Kondisi</th><th>Mode</th><th>Aksi</th><th>Terakhir</th><th></th></tr></thead><tbody>
      ${reacts.map((r) => `<tr><td><b>${esc(r.name)}</b><div class="hint">${esc(r.message)}</div></td>
        <td><code>field${r.field} ${esc(r.op)} ${esc(r.value)}</code></td>
        <td>${r.mode === 'every' ? 'Setiap data' : 'Saat berubah'}</td>
        <td>${actLabel[r.action]}<div class="hint">${esc(r.target === '-' ? '' : r.target)}</div></td>
        <td class="hint">${r.last_fired ? ago(r.last_fired) : 'belum pernah'}</td>
        <td class="row"><button class="btn sm" data-tog="${r.id}" data-en="${r.enabled}">${r.enabled ? 'Nonaktifkan' : 'Aktifkan'}</button><button class="btn sm danger" data-del="${r.id}">Hapus</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">Belum ada React</td></tr>'}
    </tbody></table></div>
    <h2>Tambah React</h2>
    <form class="card" id="rf">
      <div class="form-grid">
        <div class="f"><label>Nama</label><input type="text" name="name" required placeholder="Air masuk BAHAYA"></div>
        <div class="f"><label>Mode</label><select name="mode"><option value="change">Hanya saat kondisi baru terpenuhi</option><option value="every">Setiap data yang memenuhi</option></select></div>
        <div class="f"><label>Field</label><select name="field">${used.map((n) => `<option value="${n}">field${n}: ${esc(ch['field' + n])}</option>`).join('')}</select></div>
        <div class="f"><label>Kondisi</label><div class="row" style="flex-wrap:nowrap"><select name="op" style="width:110px">${['>=', '>', '<=', '<', '==', '!=', 'contains'].map((o) => `<option>${o}</option>`).join('')}</select><input type="text" name="value" required placeholder="240"></div></div>
        <div class="f"><label>Aksi</label><select name="action" id="act">${Object.entries(actLabel).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
        <div class="f"><label id="tl">Target</label><input type="text" name="target" id="tg" placeholder="-"></div>
      </div>
      <div class="f"><label>Pesan</label><input type="text" name="message" value="⚠️ {{channel}}: ketinggian air {{field1}} cm, status {{status}}">
        <div class="hint">Variabel: {{channel}} {{value}} {{field1}}…{{field8}} {{status}} {{created_at}} {{entry_id}}</div></div>
      <div class="row"><span class="spacer"></span><button class="btn primary">Tambah</button></div>
    </form>
    <h2>Log aksi (sejak server dinyalakan)</h2>
    <div class="card table-wrap"><table><thead><tr><th>Waktu</th><th>React</th><th>Pesan</th><th>Hasil</th></tr></thead><tbody>
      ${log.map((l) => `<tr><td class="hint">${fmtDate(l.time)}</td><td>${esc(l.react)}</td><td>${esc(l.message)}</td><td class="hint">${esc(l.result)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Belum ada aksi</td></tr>'}
    </tbody></table></div>`;
  const updTarget = () => {
    const a = $('#act').value;
    $('#tl').textContent = a === 'webhook' ? 'URL webhook' : a === 'telegram' ? 'Chat ID Telegram' : 'Target';
    $('#tg').placeholder = a === 'webhook' ? 'https://contoh.com/hook' : a === 'telegram' ? '123456789' : '(tidak perlu)';
    $('#tg').disabled = a === 'log';
  };
  $('#act').onchange = updTarget; updTarget();
  $('#rf').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', `/api/channels/${ch.id}/reacts`, Object.fromEntries(new FormData(e.target))); toast('React ditambahkan'); render(); }
    catch (err) { toast(err.message); }
  };
  el.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { await api('DELETE', `/api/reacts/${b.dataset.del}`); render(); }));
  el.querySelectorAll('[data-tog]').forEach((b) => (b.onclick = async () => { await api('PUT', `/api/reacts/${b.dataset.tog}`, { enabled: b.dataset.en !== '1' }); render(); }));
}

// ---- Tab: Pengaturan channel -------------------------------------------------
function tabEdit(el, ch) {
  el.innerHTML = `<form class="card" id="f">${channelFormHtml(ch)}
    <div class="row"><button type="button" class="btn danger" id="del">Hapus channel</button><span class="spacer"></span><button class="btn primary">Simpan</button></div></form>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    await api('PUT', `/api/channels/${ch.id}`, Object.fromEntries(new FormData(e.target)));
    toast('Tersimpan'); location.hash = `#/channel/${ch.id}/view`;
  };
  $('#del').onclick = async () => {
    if (prompt(`Ketik nama channel "${ch.name}" untuk menghapus beserta seluruh datanya:`) !== ch.name) return;
    await api('DELETE', `/api/channels/${ch.id}`); toast('Channel dihapus'); location.hash = '#/';
  };
}

// ---------------------------------------------------------------------------
// Pengaturan global
// ---------------------------------------------------------------------------
async function viewSettings() {
  if (!ME.admin) { app.innerHTML = '<div class="card empty">Login admin untuk membuka pengaturan.</div>'; return; }
  const s = await api('GET', '/api/settings');
  app.innerHTML = `<h1>Pengaturan</h1><p class="sub">Pengaturan Data Logger. Token Telegram juga bisa diatur di <a href="/console/#/settings">Konsol</a>.</p>
    <form class="card" id="f" style="max-width:620px"><h3>Bot Telegram (untuk React)</h3>
      <p class="hint">Buat bot lewat <b>@BotFather</b> di Telegram, salin tokennya ke sini. Kirim pesan apa saja ke bot, lalu buka
      <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> untuk melihat <b>chat id</b> kalian.</p>
      <div class="f"><label>Token bot</label><input type="password" name="telegram_token" value="${esc(s.telegram_token)}" placeholder="123456:ABC-DEF..."></div>
      <div class="row"><span class="spacer"></span><button class="btn primary">Simpan</button></div></form>
    <div class="card" style="max-width:620px;margin-top:14px"><h3>Server</h3>
      <p class="hint">Rate limit update: <b>${ME.rateLimitSec} detik</b> per channel (ubah lewat env <code>RATE_LIMIT_SEC</code>). Password admin diubah lewat env <code>ADMIN_PASS</code> atau <code>config.json</code>.</p></div>`;
  $('#f').onsubmit = async (e) => { e.preventDefault(); await api('PUT', '/api/settings', Object.fromEntries(new FormData(e.target))); toast('Tersimpan'); };
}

// ---------------------------------------------------------------------------
// Dokumentasi API
// ---------------------------------------------------------------------------
function viewDocs() {
  const h = location.origin;
  const rows = [
    ['GET/POST', '/update?api_key=W&field1=..&field8=..&status=..', 'Kirim satu entri. Balasan: nomor entri, atau 0 bila gagal (key salah / terlalu cepat).'],
    ['GET/POST', '/update.json', 'Sama seperti /update, balasan JSON.'],
    ['POST', '/channels/:id/bulk_update.json', 'Kirim banyak entri: {"write_api_key":"W","updates":[{"created_at":"..","field1":1}]}'],
    ['GET', '/channels/:id/feeds.json', 'Daftar entri. Parameter: results, minutes, days, start, end, api_key'],
    ['GET', '/channels/:id/feeds.csv', 'Daftar entri dalam CSV.'],
    ['GET', '/channels/:id/feeds/last.json', 'Entri terakhir.'],
    ['GET', '/channels/:id/fields/:n.json', 'Data satu field (n = 1..8).'],
    ['GET', '/channels/:id/fields/:n/last.txt', 'Nilai terakhir satu field sebagai teks polos.'],
    ['GET', '/channels/:id/status.json', 'Riwayat kolom status.'],
    ['GET', '/channels/:id.json', 'Info channel.'],
    ['GET', '/channels/:id/stream', 'Server-Sent Events: data baru dikirim real-time (event "feed").'],
  ];
  app.innerHTML = `<h1>Dokumentasi API</h1>
    <p class="sub">API Data Logger AwasLink mengikuti pola ThingSpeak, jadi contoh kode/library ThingSpeak biasanya bisa dipakai dengan mengganti alamat server. Channel privat butuh <code>api_key</code> (Read atau Write key), bisa juga lewat header <code>X-THINGSPEAKAPIKEY</code>.</p>
    <div class="card table-wrap"><table><thead><tr><th>Metode</th><th>Endpoint</th><th>Keterangan</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><code>${r[0]}</code></td><td><code>${esc(r[1])}</code></td><td>${esc(r[2])}</td></tr>`).join('')}</tbody></table></div>
    <h2>Contoh ESP32 (Arduino)</h2>
    <pre>#include &lt;HTTPClient.h&gt;
HTTPClient http;
String url = "${h}/update?api_key=WRITE_KEY&amp;field1=" + String(level) + "&amp;field2=" + String(adc);
http.begin(url);
int code = http.GET();          // 200 bila berhasil
String entry = http.getString(); // nomor entri, "0" bila ditolak
http.end();</pre>
    <h2>Contoh baca data (JavaScript)</h2>
    <pre>const r = await fetch("${h}/channels/1/feeds.json?results=20&amp;api_key=READ_KEY");
const { channel, feeds } = await r.json();</pre>
    <h2>Format waktu</h2>
    <p>Semua waktu dalam UTC, format ISO 8601 (<code>2026-11-07T10:15:00Z</code>). Parameter <code>start</code>/<code>end</code> menerima <code>YYYY-MM-DD HH:MM:SS</code> (UTC).</p>`;
}

loadMe().then(render);
